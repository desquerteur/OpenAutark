// Owns: one RFC 6455 client connection (wss via the platform's TLS with normal certificate checks, ws for local tests):
// the upgrade, masked frames, fragments, ping/pong and close. Never: skips certificate checks or reconnects by itself.
package com.teydralab.autark.android.relay;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

public final class WebSocketClient {
    public interface Listener {
        void text(String text);
        void binary(byte[] data);
        void closed(String reason);
    }

    /** Largest message accepted from the server (control frames ≤ 16 KiB, tunnel frames ≤ 64 KiB + header). */
    private static final int MAX_MESSAGE = 70 * 1024;

    private final Socket socket;
    private final OutputStream out;
    private final DataInputStream in;
    private final Listener listener;
    private volatile boolean closed;

    private WebSocketClient(Socket socket, InputStream in, Listener listener) throws IOException {
        this.socket = socket;
        this.out = socket.getOutputStream();
        this.in = new DataInputStream(in);
        this.listener = listener;
    }

    /** Connects and upgrades; the listener hears frames on a reader thread of its own. */
    public static WebSocketClient connect(String url, Listener listener) throws IOException { return connect(url, listener, ""); }

    /** The same with extra request header lines ("Cookie: …\r\n" – the phone's own socket through its local entrance). */
    public static WebSocketClient connect(String url, Listener listener, String headers) throws IOException {
        if (headers.indexOf('\n') >= 0 && !headers.endsWith("\r\n")) throw new IOException("Bad header lines");
        URI uri = URI.create(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        boolean tls = scheme.equals("wss");
        if (!tls && !scheme.equals("ws")) throw new IOException("Not a WebSocket address");
        String host = uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), 10_000);
        raw.setTcpNoDelay(true);
        Socket socket = raw;
        if (tls) {
            SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
            SSLParameters parameters = ssl.getSSLParameters();
            parameters.setEndpointIdentificationAlgorithm("HTTPS"); // the server name must match its certificate
            ssl.setSSLParameters(parameters);
            ssl.startHandshake();
            // Android's platform verifier checks the name once more (the desktop JDK's default one is a placeholder that
            // refuses everything; there the endpoint identification above is the check).
            boolean android = System.getProperty("java.vendor", "").toLowerCase(Locale.ROOT).contains("android");
            if (android && !HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.getSession())) { ssl.close(); throw new IOException("Certificate does not match " + host); }
            socket = ssl;
        }
        socket.setSoTimeout(15_000);
        String key = Crypto.b64urlStd(Crypto.random(16));
        String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath()) + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        String request = "GET " + path + " HTTP/1.1\r\nHost: " + host + (uri.getPort() > 0 ? ":" + port : "") + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\nUser-Agent: AutarkAndroid\r\n" + headers + "\r\n";
        socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().flush();
        InputStream input = socket.getInputStream();
        String head = readHead(input);
        if (!head.startsWith("HTTP/1.1 101")) { socket.close(); throw new IOException("The server did not accept the WebSocket (" + head.split("\r\n", 2)[0] + ")"); }
        String accept = Crypto.b64urlStd(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
        if (!head.toLowerCase(Locale.ROOT).contains("sec-websocket-accept: " + accept.toLowerCase(Locale.ROOT))) { socket.close(); throw new IOException("Bad WebSocket accept"); }
        socket.setSoTimeout(0); // the relay pings every 30 s; RelayLink's watchdog ends a silent connection
        WebSocketClient client = new WebSocketClient(socket, input, listener);
        Thread reader = new Thread(client::readLoop, "autark-relay-reader");
        reader.setDaemon(true);
        reader.start();
        return client;
    }

    /** RFC 6455 fixes SHA-1 for the upgrade answer (not a security use). */
    private static byte[] sha1(String text) {
        try { return java.security.MessageDigest.getInstance("SHA-1").digest(text.getBytes(StandardCharsets.US_ASCII)); }
        catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    static String readHead(InputStream input) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int b = input.read();
            if (b < 0) throw new IOException("Connection closed during the upgrade");
            head.write(b);
            if (head.size() > 16 * 1024) throw new IOException("Upgrade answer too long");
            matched = (b == (matched % 2 == 0 ? '\r' : '\n')) ? matched + 1 : (b == '\r' ? 1 : 0);
        }
        return head.toString("ISO-8859-1");
    }

    public void sendText(String text) throws IOException { send(0x1, text.getBytes(StandardCharsets.UTF_8)); }

    public void sendBinary(byte[] data) throws IOException { send(0x2, data); }

    public boolean isClosed() { return closed; }

    public void close() {
        if (closed) return;
        try { send(0x8, new byte[] { 0x03, (byte) 0xe8 }); } catch (IOException ignored) { /* already gone */ }
        shutdown("closed");
    }

    private synchronized void send(int opcode, byte[] payload) throws IOException {
        if (closed && opcode != 0x8) throw new IOException("closed");
        ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
        frame.write(0x80 | opcode);
        int length = payload.length;
        if (length < 126) frame.write(0x80 | length);
        else if (length < 65536) { frame.write(0x80 | 126); frame.write(length >>> 8); frame.write(length & 0xff); }
        else { frame.write(0x80 | 127); for (int i = 7; i >= 0; i--) frame.write((int) (((long) length) >>> (8 * i)) & 0xff); }
        byte[] mask = Crypto.random(4);
        frame.write(mask, 0, 4);
        byte[] masked = new byte[length];
        for (int i = 0; i < length; i++) masked[i] = (byte) (payload[i] ^ mask[i & 3]);
        frame.write(masked, 0, length);
        out.write(frame.toByteArray());
        out.flush();
    }

    private void readLoop() {
        String reason = "closed";
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int messageType = 0;
        try {
            while (!closed) {
                int first = in.readUnsignedByte();
                int second = in.readUnsignedByte();
                boolean fin = (first & 0x80) != 0;
                int opcode = first & 0x0f;
                long length = second & 0x7f;
                if (length == 126) length = in.readUnsignedShort();
                else if (length == 127) length = in.readLong();
                if ((second & 0x80) != 0) throw new IOException("masked server frame");
                if (length > MAX_MESSAGE || length < 0) throw new IOException("frame too large");
                byte[] payload = new byte[(int) length];
                in.readFully(payload);
                if (opcode == 0x9) { send(0xA, payload); continue; }
                if (opcode == 0xA) continue;
                if (opcode == 0x8) { reason = "server closed (" + (payload.length >= 2 ? ((payload[0] & 0xff) << 8 | (payload[1] & 0xff)) : 1005) + ")"; break; }
                if (opcode == 0x1 || opcode == 0x2) { messageType = opcode; message.reset(); }
                else if (opcode != 0x0) throw new IOException("unknown opcode");
                message.write(payload, 0, payload.length);
                if (message.size() > MAX_MESSAGE) throw new IOException("message too large");
                if (!fin) continue;
                byte[] whole = message.toByteArray();
                message.reset();
                if (messageType == 0x1) listener.text(new String(whole, StandardCharsets.UTF_8));
                else listener.binary(whole);
            }
        } catch (IOException | RuntimeException error) {
            if (!closed) reason = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        }
        shutdown(reason);
    }

    private void shutdown(String reason) {
        boolean first;
        synchronized (this) { first = !closed; closed = true; }
        try { socket.close(); } catch (IOException ignored) { /* closing */ }
        if (first) listener.closed(reason);
    }
}
