// Owns: one meeting-server tunnel exactly as rendezvous/tunnel.ts frames it – [u32 tunnel id][flags][≤ 60 KiB chunk],
// flag MORE joins chunks, text (handshake) frames sealed to the other device with the counter cipher of seal.ts.
// Never: decides trust (the peer handshake does) or holds more than one message being joined.
package com.teydralab.autark.android.relay;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

public final class Tunnel {
    public interface Listener {
        void message(byte[] data, boolean text);
        void closed();
    }

    interface Link {
        void send(byte[] frame);
        void close(int tid);
    }

    static final int HEADER = 5;
    static final int CHUNK = 60 * 1024;
    private static final int TEXT = 1;
    private static final int MORE = 2;
    private static final int MAX_MESSAGE = 8 * 1024 * 1024 + 1024;

    final int tid;
    final String peer;
    private final Link link;
    private final byte[] sendKey;
    private final byte[] receiveKey;
    private long sent;
    private long received;
    private final ByteArrayOutputStream parts = new ByteArrayOutputStream();
    private volatile Listener listener;
    private volatile boolean closed;

    Tunnel(int tid, String peer, Link link, byte[] sendKey, byte[] receiveKey) {
        this.tid = tid;
        this.peer = peer;
        this.link = link;
        this.sendKey = sendKey;
        this.receiveKey = receiveKey;
    }

    public void listen(Listener listener) { this.listener = listener; }

    public boolean isClosed() { return closed; }

    public synchronized void sendText(String text) {
        byte[] sealed = Crypto.seal(sendKey, sent++, text.getBytes(StandardCharsets.UTF_8));
        frames(sealed, true);
    }

    public synchronized void sendBinary(byte[] data) { frames(data, false); }

    private void frames(byte[] body, boolean text) {
        if (closed) return;
        int offset = 0;
        do {
            int length = Math.min(CHUNK, body.length - offset);
            boolean more = offset + length < body.length;
            byte[] frame = new byte[HEADER + length];
            frame[0] = (byte) (tid >>> 24); frame[1] = (byte) (tid >>> 16); frame[2] = (byte) (tid >>> 8); frame[3] = (byte) tid;
            frame[4] = (byte) ((text ? TEXT : 0) | (more ? MORE : 0));
            System.arraycopy(body, offset, frame, HEADER, length);
            link.send(frame);
            offset += length;
        } while (offset < body.length);
    }

    /** A binary frame from the server for this tunnel (called on the reader thread). */
    void receive(byte[] frame) {
        if (closed || frame.length < HEADER) return;
        int flags = frame[4];
        parts.write(frame, HEADER, frame.length - HEADER);
        if (parts.size() > MAX_MESSAGE) { close(); return; }
        if ((flags & MORE) != 0) return;
        byte[] whole = parts.toByteArray();
        parts.reset();
        boolean text = (flags & TEXT) != 0;
        if (text) {
            whole = Crypto.open(receiveKey, received, whole, 0, whole.length);
            if (whole == null) { close(); return; }
            received++;
        }
        Listener target = listener;
        if (target != null) target.message(whole, text);
    }

    public void close() {
        if (closed) return;
        try { link.close(tid); } catch (RuntimeException ignored) { /* relay gone */ }
        ended();
    }

    /** The server or the connection ended the tunnel. */
    void ended() {
        if (closed) return;
        closed = true;
        Listener target = listener;
        if (target != null) target.closed();
    }
}
