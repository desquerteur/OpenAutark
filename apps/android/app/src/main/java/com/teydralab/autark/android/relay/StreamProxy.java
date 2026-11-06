// Owns: the phone's local entrance to its PC – a listener on 127.0.0.1 only the app's own WebView passes (its first
// request carries the app's private gate cookie), each TCP connection one stream over the encrypted peer channel to the
// PC's own runtime port (rendezvous/phone.ts: o/d/a/e messages, at most WINDOW unacknowledged bytes per direction).
// The WebView therefore shows the PC's unchanged phone UI at http://127.0.0.1:<port>, a secure context like https.
// Never: listens beyond loopback, lets another app's connection through, or buffers without bound.
package com.teydralab.autark.android.relay;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;

public final class StreamProxy {
    /** The current channel to the PC, waited for up to a few seconds when a stream starts. */
    public interface Channels { PeerChannel await(long timeoutMs); }

    public static final String GATE_COOKIE = "autark_gate";
    static final int WINDOW = 256 * 1024;
    private static final int CHUNK = 32 * 1024;
    private static final byte[] END = new byte[0];

    private final ServerSocket server;
    private final String gate;
    private final Channels channels;
    private final Map<PeerChannel, Map<Integer, Stream>> live = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private volatile boolean closed;

    /** Listens on 127.0.0.1:`port` (0 or a taken port: any free one). */
    public StreamProxy(int port, String gate, Channels channels) throws IOException {
        this.gate = gate;
        this.channels = channels;
        ServerSocket socket = new ServerSocket();
        try { socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 32); }
        catch (IOException taken) { socket.close(); socket = new ServerSocket(); socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 32); }
        server = socket;
        Thread accept = new Thread(this::acceptLoop, "autark-proxy");
        accept.setDaemon(true);
        accept.start();
    }

    public int port() { return server.getLocalPort(); }

    public String origin() { return "http://127.0.0.1:" + port(); }

    public void close() {
        closed = true;
        try { server.close(); } catch (IOException ignored) { /* closing */ }
    }

    /** Messages of a channel from the PC: the bytes and acknowledgements of this proxy's streams. */
    public void deliver(PeerChannel channel, Map<String, Object> message) {
        Map<Integer, Stream> streams = live.get(channel);
        if (streams == null) return;
        Stream stream = streams.get((int) Json.num(message, "s", -1));
        if (stream == null) return;
        String type = Json.str(message, "t");
        if ("d".equals(type)) {
            String b = Json.str(message, "b");
            if (b != null) stream.toLocal.offer(Base64.getDecoder().decode(b));
        } else if ("a".equals(type)) stream.acked(Json.num(message, "n", 0));
        else if ("e".equals(type)) stream.toLocal.offer(END);
    }

    /** The channel ended: its streams end, the WebView reconnects on its own. */
    public void channelClosed(PeerChannel channel) {
        Map<Integer, Stream> streams = live.remove(channel);
        if (streams != null) for (Stream stream : streams.values()) stream.toLocal.offer(END);
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                Thread worker = new Thread(() -> serve(socket), "autark-stream");
                worker.setDaemon(true);
                worker.start();
            } catch (IOException error) {
                if (closed) return;
            }
        }
    }

    private void serve(Socket socket) {
        try {
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(15_000);
            InputStream in = socket.getInputStream();
            byte[] head = readHead(in);
            if (head == null || !hasGate(new String(head, StandardCharsets.ISO_8859_1))) {
                socket.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                socket.close();
                return;
            }
            socket.setSoTimeout(0);
            PeerChannel channel = channels.await(20_000);
            if (channel == null || channel.isClosed()) {
                byte[] body = "Your PC is not reachable right now. Autark must be running on it.".getBytes(StandardCharsets.UTF_8);
                socket.getOutputStream().write(("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                socket.getOutputStream().write(body);
                socket.close();
                return;
            }
            Stream stream = new Stream(nextId.getAndIncrement(), channel, socket);
            live.computeIfAbsent(channel, key -> new ConcurrentHashMap<>()).put(stream.id, stream);
            if (channel.isClosed()) channelClosed(channel);
            channel.send(Json.map("t", "o", "s", stream.id));
            stream.start();
            stream.upload(head);
            byte[] buffer = new byte[CHUNK];
            for (;;) {
                int read = in.read(buffer);
                if (read < 0) break;
                byte[] chunk = new byte[read];
                System.arraycopy(buffer, 0, chunk, 0, read);
                if (!stream.upload(chunk)) break;
            }
            stream.finish(true);
        } catch (IOException error) {
            try { socket.close(); } catch (IOException ignored) { /* closing */ }
        }
    }

    private boolean hasGate(String head) {
        for (String line : head.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0 || !line.substring(0, colon).trim().toLowerCase(Locale.ROOT).equals("cookie")) continue;
            for (String part : line.substring(colon + 1).split(";")) {
                String[] pair = part.trim().split("=", 2);
                if (pair.length == 2 && pair[0].equals(GATE_COOKIE) && constantEquals(pair[1], gate)) return true;
            }
        }
        return false;
    }

    private static boolean constantEquals(String a, String b) {
        return java.security.MessageDigest.isEqual(Crypto.sha256(Crypto.utf8(a)), Crypto.sha256(Crypto.utf8(b)));
    }

    /** The first request head (through the empty line), or null when it is not one. */
    private static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int b = in.read();
            if (b < 0 || head.size() > 32 * 1024) return null;
            head.write(b);
            matched = (b == (matched % 2 == 0 ? '\r' : '\n')) ? matched + 1 : (b == '\r' ? 1 : 0);
        }
        return head.toByteArray();
    }

    private final class Stream {
        final int id;
        final PeerChannel channel;
        final Socket socket;
        final LinkedBlockingQueue<byte[]> toLocal = new LinkedBlockingQueue<>();
        private long unacked;
        private boolean done;

        Stream(int id, PeerChannel channel, Socket socket) { this.id = id; this.channel = channel; this.socket = socket; }

        /** Bytes from the PC go to the WebView on a thread of their own; each written chunk is acknowledged. */
        void start() {
            Thread writer = new Thread(() -> {
                try {
                    OutputStream out = socket.getOutputStream();
                    for (;;) {
                        byte[] data = toLocal.take();
                        if (data == END) break;
                        out.write(data);
                        out.flush();
                        channel.send(Json.map("t", "a", "s", id, "n", data.length));
                    }
                } catch (IOException | InterruptedException error) { /* the WebView closed it */ }
                finish(true);
            }, "autark-stream-out");
            writer.setDaemon(true);
            writer.start();
        }

        /** Sends bytes to the PC, waiting while WINDOW bytes are unacknowledged; false once the stream ended. */
        boolean upload(byte[] data) {
            synchronized (this) {
                while (!done && unacked >= WINDOW) {
                    try { wait(1_000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); return false; }
                    if (channel.isClosed()) done = true;
                }
                if (done) return false;
                unacked += data.length;
            }
            channel.send(Json.map("t", "d", "s", id, "b", Base64.getEncoder().encodeToString(data)));
            return true;
        }

        synchronized void acked(long n) {
            unacked = Math.max(0, unacked - n);
            notifyAll();
        }

        void finish(boolean tell) {
            synchronized (this) {
                if (done && socket.isClosed()) return;
                done = true;
                notifyAll();
            }
            Map<Integer, Stream> streams = live.get(channel);
            boolean mine = streams != null && streams.remove(id) != null;
            if (tell && mine) channel.send(Json.map("t", "e", "s", id));
            toLocal.offer(END);
            try { socket.close(); } catch (IOException ignored) { /* closing */ }
        }
    }

    /** For a test or the status line: open streams over all channels. */
    public int openStreams() {
        int count = 0;
        for (Map<Integer, Stream> streams : live.values()) count += streams.size();
        return count;
    }
}
