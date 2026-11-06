// Autark desktop broker (B-077): one small exe, two roles.
//   AutarkDesktopBroker.exe service <userSid>          – the Windows service (LocalSystem, Session 0, auto start)
//   AutarkDesktopBroker.exe worker <userSid> <keyFile> – the worker in the console session (see Worker.cs)
// The service shows nothing and types nothing (Session 0 cannot reach the interactive session). It duplicates its
// own LocalSystem token, sets TokenSessionId to WTSGetActiveConsoleSessionId and starts the worker with
// CreateProcessAsUser on "winsta0\winlogon". On SERVICE_CONTROL_SESSIONCHANGE it starts the worker again when the
// console session changed; when the worker exits it starts it again (1 s, doubling up to 30 s while it keeps dying).
// Owns: the service lifetime, the worker process and the short broker.log in %ProgramData%\AutarkDesktopBroker.
// Never: reads the key, opens the pipe or handles input (Worker.cs), or writes anything typed into the log.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace AutarkBroker
{
    public static class Program
    {
        public const string ServiceName = "AutarkDesktopBroker";

        public static string DataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), ServiceName); }
        }

        public static int Main(string[] args)
        {
            string role = args.Length > 0 ? args[0] : "";
            if (role == "service" && args.Length >= 2)
            {
                ServiceBase.Run(new BrokerService(args[1]));
                return 0;
            }
            if (role == "worker" && args.Length >= 3) return Worker.Run(args[1], args[2]);
            Console.Error.WriteLine("usage: AutarkDesktopBroker.exe service <userSid> | worker <userSid> <keyFile>");
            return 2;
        }

        static readonly object logGate = new object();

        /// One line in broker.log (start, restart, failures – never anything typed); the file is kept below 256 KB.
        public static void Log(string line)
        {
            try
            {
                lock (logGate)
                {
                    string file = Path.Combine(DataDir, "broker.log");
                    if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024) File.Delete(file);
                    File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
                }
            }
            catch (Exception) { }
        }
    }

    public class BrokerService : ServiceBase
    {
        const uint NoSession = 0xFFFFFFFF;
        readonly string userSid;
        readonly object gate = new object();
        Process worker;
        uint workerSession = NoSession;
        bool stopping;
        int quickExits;
        DateTime startedAt;
        Timer retry;

        public BrokerService(string userSid)
        {
            this.userSid = userSid;
            ServiceName = Program.ServiceName;
            CanStop = true;
            CanShutdown = true;
            CanHandleSessionChangeEvent = true;
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            Program.Log("service started");
            lock (gate) StartWorker();
        }

        protected override void OnStop()
        {
            lock (gate) { stopping = true; KillWorker(); }
            Program.Log("service stopped");
        }

        protected override void OnShutdown() { OnStop(); }

        protected override void OnSessionChange(SessionChangeDescription change)
        {
            lock (gate)
            {
                if (stopping) return;
                uint console = Native.WTSGetActiveConsoleSessionId();
                bool alive = worker != null && !worker.HasExited;
                if (alive && console == workerSession) return; // lock/unlock: the worker follows the input desktop itself
                Program.Log("session change " + change.Reason + ": console session " + console);
                quickExits = 0;
                KillWorker();
                StartWorker();
            }
        }

        void StartWorker()
        {
            uint session = Native.WTSGetActiveConsoleSessionId();
            if (session == NoSession) { Program.Log("no console session yet; waiting for the next session change"); return; }
            string exe = Process.GetCurrentProcess().MainModule.FileName;
            string keyFile = Path.Combine(Program.DataDir, "broker.key");
            string command = "\"" + exe + "\" worker " + userSid + " \"" + keyFile + "\"";
            try
            {
                int pid = Native.StartInSession(session, command, "winsta0\\winlogon");
                Process process = Process.GetProcessById(pid);
                process.EnableRaisingEvents = true;
                process.Exited += (sender, e) => OnWorkerExit((Process)sender);
                worker = process;
                workerSession = session;
                startedAt = DateTime.UtcNow;
                Program.Log("worker " + pid + " started in session " + session);
            }
            catch (Exception e)
            {
                Program.Log("worker start failed: " + e.Message);
                ScheduleRetry();
            }
        }

        void OnWorkerExit(Process process)
        {
            lock (gate)
            {
                if (stopping || process != worker) return;
                int code = -1;
                try { code = process.ExitCode; } catch (Exception) { }
                Program.Log("worker exited with " + code);
                worker = null;
                if ((DateTime.UtcNow - startedAt).TotalSeconds < 60) quickExits++; else quickExits = 0;
                ScheduleRetry();
            }
        }

        void ScheduleRetry()
        {
            int delay = (int)Math.Min(30000, 1000 * Math.Pow(2, Math.Min(quickExits, 5)));
            if (retry != null) retry.Dispose();
            retry = new Timer(_ => { lock (gate) { if (!stopping && worker == null) StartWorker(); } }, null, delay, Timeout.Infinite);
        }

        void KillWorker()
        {
            Process process = worker;
            worker = null;
            workerSession = NoSession;
            if (process == null) return;
            try { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } } catch (Exception) { }
        }
    }

    static class Native
    {
        const uint TOKEN_ALL_ACCESS = 0xF01FF;
        const int TokenSessionId = 12;
        const int SecurityImpersonation = 2;
        const int TokenPrimary = 1;
        const uint CREATE_NO_WINDOW = 0x08000000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessAsUser(IntPtr token, string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);

        /// Starts `command` with a copy of this process's own (LocalSystem) token moved into `session`, on `desktop`.
        public static int StartInSession(uint session, string command, string desktop)
        {
            IntPtr own = IntPtr.Zero, token = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out own)) throw new Win32Exception();
                if (!DuplicateTokenEx(own, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out token)) throw new Win32Exception();
                if (!SetTokenInformation(token, TokenSessionId, ref session, 4)) throw new Win32Exception();
                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.lpDesktop = desktop;
                PROCESS_INFORMATION info;
                if (!CreateProcessAsUser(token, null, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out info))
                    throw new Win32Exception();
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                return info.dwProcessId;
            }
            finally
            {
                if (token != IntPtr.Zero) CloseHandle(token);
                if (own != IntPtr.Zero) CloseHandle(own);
            }
        }
    }
}
