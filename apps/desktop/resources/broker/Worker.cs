// The broker worker (B-077): runs in the console session with the service's SYSTEM token and serves the computer-use
// protocol of resources/computer/windows-helper.ps1 on \\.\pipe\AutarkDesktopBroker. The helper's C# part is
// compiled into this exe (build.ps1 cuts it out of the .ps1), so every op answers exactly like the PowerShell
// helper; only 'ocr' answers 'unavailable' (it is PowerShell/WinRT there).
// Each request runs on a fresh thread that first calls OpenInputDesktop + SetThreadDesktop: screenshot (BitBlt),
// SendInput and UI Automation then work on whatever desktop takes input right now – Winlogon (locked, UAC prompt),
// Default or Screen-saver. Every answer line ends with "desktop":"<name>" so the runtime can tell the screen is locked.
// Pipe: ACL SYSTEM and this process's account (full), the installing user (read/write), NETWORK denied.
// Handshake: {"broker":1,"nonce"} → {"hello":HMAC(key,"hello"|sn|cn),"nonce":cn} → the helper's ready line plus
// "proof":HMAC(key,"proof"|sn|cn). Typed text arrives sealed (args.sealed: AES-256-CBC + HMAC-SHA256 with keys
// from the session key HMAC(key,"session"|sn|cn), ids strictly increasing): it is decrypted right before
// SendInput / set_value and zeroed after, and never echoed, logged or returned.
// Owns: the pipe, the handshake, opening the sealed text, the desktop switch per request and the request queue.
// Never: starts processes, writes typed text anywhere, or runs two requests at once.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using WorkforceHelper;

namespace AutarkBroker
{
    public static class Worker
    {
        public const string PipeName = "AutarkDesktopBroker";
        static readonly object dispatchGate = new object();
        static byte[] key;
        static bool dpiAware;

        public static int Run(string userSid, string keyFile)
        {
            try
            {
                key = Convert.FromBase64String(File.ReadAllText(keyFile).Trim());
                if (key.Length != 32) throw new InvalidDataException("broker.key must hold 32 bytes.");
                SecurityIdentifier user = new SecurityIdentifier(userSid);
                dpiAware = WorkforceHelper.Native.InitDpi();
                Program.Log("worker " + System.Diagnostics.Process.GetCurrentProcess().Id + " listening");
                while (true)
                {
                    NamedPipeServerStream pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous, 64 * 1024, 64 * 1024, Security(user)); // overlapped: the reader and the writer thread never block each other
                    pipe.WaitForConnection();
                    Thread serve = new Thread(() => Serve(pipe));
                    serve.IsBackground = true;
                    serve.Start();
                }
            }
            catch (Exception e)
            {
                Program.Log("worker failed: " + e.GetType().Name + ": " + e.Message);
                Console.Error.WriteLine(e.Message);
                return 1;
            }
        }

        static PipeSecurity Security(SecurityIdentifier user)
        {
            PipeSecurity security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite | PipeAccessRights.ReadPermissions | PipeAccessRights.Synchronize, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            return security;
        }

        // ------------------------------------------------------------------ one connection

        static void Serve(NamedPipeServerStream pipe)
        {
            UTF8Encoding utf8 = new UTF8Encoding(false);
            try
            {
                using (pipe)
                {
                    StreamReader reader = new StreamReader(pipe, utf8);
                    StreamWriter writer = new StreamWriter(pipe, utf8);
                    writer.AutoFlush = true;
                    writer.NewLine = "\n";
                    byte[] session = Handshake(reader, writer);
                    if (session == null) return;
                    Sealer sealer = new Sealer(session);
                    BlockingCollection<string> queue = new BlockingCollection<string>();
                    ManualResetEventSlim idle = new ManualResetEventSlim(true);
                    Thread run = new Thread(() =>
                    {
                        foreach (string line in queue.GetConsumingEnumerable())
                        {
                            idle.Reset();
                            string answer = Answer(line, sealer);
                            idle.Set();
                            lock (writer) { try { writer.WriteLine(answer); } catch (IOException) { } }
                        }
                    });
                    run.IsBackground = true;
                    run.Start();
                    string request;
                    while ((request = reader.ReadLine()) != null) if (request.Trim().Length > 0) queue.Add(request);
                    queue.CompleteAdding();
                    // The runtime closed the pipe after a timeout: a request still hanging (UIA) blocks every later one,
                    // so the worker ends and the service starts a fresh one – like the runtime kills a hung helper.
                    if (!idle.Wait(5000)) { Program.Log("request still running after the client left; restarting the worker"); Environment.Exit(3); }
                    run.Join();
                }
            }
            catch (IOException) { }
            catch (Exception e) { Program.Log("connection failed: " + e.GetType().Name); }
        }

        static byte[] Handshake(StreamReader reader, StreamWriter writer)
        {
            byte[] serverNonce = Random(16);
            Dictionary<string, object> hello = new Dictionary<string, object>();
            hello["broker"] = 1;
            hello["nonce"] = Convert.ToBase64String(serverNonce);
            writer.WriteLine(Json.Write(hello));
            string line = reader.ReadLine();
            if (line == null) return null;
            Dictionary<string, object> reply = Json.Parse(line) as Dictionary<string, object>;
            byte[] clientNonce = Bytes(reply, "nonce");
            byte[] mac = Bytes(reply, "hello");
            if (clientNonce == null || clientNonce.Length != 16 || mac == null || !Same(mac, Mac(key, "hello", serverNonce, clientNonce)))
            {
                Program.Log("a client failed the handshake");
                return null;
            }
            Dictionary<string, object> ready = (Dictionary<string, object>)Json.Parse(Dispatcher.Ready(dpiAware));
            ready["proof"] = Convert.ToBase64String(Mac(key, "proof", serverNonce, clientNonce));
            ready["desktop"] = InputDesktopName();
            writer.WriteLine(Json.Write(ready));
            return Mac(key, "session", serverNonce, clientNonce);
        }

        // ------------------------------------------------------------------ one request

        static string Answer(string line, Sealer sealer)
        {
            object id = null;
            Dictionary<string, object> request;
            try
            {
                request = (Dictionary<string, object>)Json.Parse(line);
                id = Args.Get(request, "id");
            }
            catch (Exception) { return Dispatcher.Fail(id, "bad_request", "Invalid request line."); }
            string op = Args.Str(request, "op", "");
            if (op == "ocr") return WithDesktop(Dispatcher.Fail(id, "unavailable", "Text recognition is not available through the desktop broker."), InputDesktopName());
            Dictionary<string, object> args = Args.Obj(request, "args");
            string opened = null;
            try
            {
                if (args != null && args.ContainsKey("sealed"))
                {
                    try { opened = sealer.Open(id, op, Args.Obj(args, "sealed")); }
                    catch (Exception) { return WithDesktop(Dispatcher.Fail(id, "bad_request", "The sealed text could not be opened."), InputDesktopName()); }
                    args.Remove("sealed");
                    if (op == "type_secret") { request["op"] = "type"; args["text"] = opened; }
                    else args["value"] = opened;
                }
                string desktop = null;
                string answer = OnInputDesktop(() => Dispatcher.Handle(request), out desktop);
                return answer == null ? WithDesktop(Dispatcher.Fail(id, "unavailable", "The desktop that takes input cannot be opened (" + desktop + ")."), "") : WithDesktop(answer, desktop);
            }
            finally
            {
                Zero(opened);
            }
        }

        /// Runs `work` on a fresh MTA thread attached to the input desktop (a fresh thread owns no window, so SetThreadDesktop works).
        static string OnInputDesktop(Func<string> work, out string desktop)
        {
            string answer = null, name = null;
            IntPtr handle = IntPtr.Zero;
            Thread thread = new Thread(() =>
            {
                handle = OpenInputDesktop(0, false, DESKTOP_ALL);
                if (handle == IntPtr.Zero) { name = new Win32Exception().Message; return; }
                if (!SetThreadDesktop(handle)) { name = new Win32Exception().Message; return; }
                name = DesktopName(handle);
                lock (dispatchGate) answer = work();
            });
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            thread.Join();
            if (handle != IntPtr.Zero) CloseDesktop(handle);
            desktop = name ?? "";
            return answer;
        }

        static string WithDesktop(string answer, string desktop)
        {
            return answer.Substring(0, answer.Length - 1) + ",\"desktop\":" + Json.Write(desktop ?? "") + "}";
        }

        static string InputDesktopName()
        {
            IntPtr handle = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
            if (handle == IntPtr.Zero) return "";
            try { return DesktopName(handle); } finally { CloseDesktop(handle); }
        }

        static string DesktopName(IntPtr handle)
        {
            byte[] buffer = new byte[256];
            int needed;
            if (!GetUserObjectInformation(handle, UOI_NAME, buffer, buffer.Length, out needed)) return "";
            return Encoding.Unicode.GetString(buffer, 0, Math.Max(0, needed - 2)).TrimEnd('\0');
        }

        /// Overwrites the characters of a string that held typed text (best effort: the runtime may have copied it before).
        static unsafe void Zero(string text)
        {
            if (text == null) return;
            fixed (char* chars = text) for (int i = 0; i < text.Length; i++) chars[i] = '\0';
        }

        // ------------------------------------------------------------------ crypto

        internal static byte[] Mac(byte[] macKey, string label, byte[] a, byte[] b)
        {
            using (HMACSHA256 hmac = new HMACSHA256(macKey))
            {
                byte[] head = Encoding.UTF8.GetBytes(label);
                byte[] all = new byte[head.Length + a.Length + b.Length];
                Buffer.BlockCopy(head, 0, all, 0, head.Length);
                Buffer.BlockCopy(a, 0, all, head.Length, a.Length);
                Buffer.BlockCopy(b, 0, all, head.Length + a.Length, b.Length);
                return hmac.ComputeHash(all);
            }
        }

        internal static bool Same(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        static byte[] Random(int length)
        {
            byte[] bytes = new byte[length];
            using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(bytes);
            return bytes;
        }

        static byte[] Bytes(Dictionary<string, object> d, string name)
        {
            string text = d == null ? null : Args.Str(d, name, null);
            if (text == null) return null;
            try { return Convert.FromBase64String(text); } catch (FormatException) { return null; }
        }

        class Sealer
        {
            readonly byte[] encKey, macKey;
            double lastId = double.NegativeInfinity;

            public Sealer(byte[] session)
            {
                encKey = Mac(session, "enc", new byte[0], new byte[0]);
                macKey = Mac(session, "mac", new byte[0], new byte[0]);
            }

            /// The text of `sealed` = {iv, data, mac}; mac = HMAC(macKey, "<id>\n<op>\n" | iv | data); each id once, increasing.
            public string Open(object id, string op, Dictionary<string, object> sealedText)
            {
                if (!(id is double) || (double)id <= lastId) throw new CryptographicException("replayed");
                byte[] iv = Bytes(sealedText, "iv"), data = Bytes(sealedText, "data"), mac = Bytes(sealedText, "mac");
                if (iv == null || iv.Length != 16 || data == null || mac == null) throw new CryptographicException("malformed");
                string head = ((long)(double)id).ToString(CultureInfo.InvariantCulture) + "\n" + op + "\n";
                if (!Same(mac, Mac(macKey, head, iv, data))) throw new CryptographicException("mac");
                lastId = (double)id;
                byte[] plain = null;
                try
                {
                    using (AesCryptoServiceProvider aes = new AesCryptoServiceProvider())
                    {
                        aes.Key = encKey; aes.IV = iv; aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.PKCS7;
                        using (ICryptoTransform decryptor = aes.CreateDecryptor()) plain = decryptor.TransformFinalBlock(data, 0, data.Length);
                    }
                    return Encoding.UTF8.GetString(plain);
                }
                finally
                {
                    if (plain != null) Array.Clear(plain, 0, plain.Length);
                }
            }
        }

        // ------------------------------------------------------------------ desktops

        const uint DESKTOP_READOBJECTS = 0x0001;
        const uint DESKTOP_ALL = 0x01FF;
        const int UOI_NAME = 2;
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
        static extern bool GetUserObjectInformation(IntPtr obj, int index, byte[] info, int length, out int needed);
    }
}
