// Owns: this phone's side of the PC's connect request (B-078: the phone pairs like a PC, role "phone"), byte for byte
// as apps/desktop/src/runtime/remote/{sas,join}.ts and devices/pair-proof.ts: remote1 with the phone's own key and an
// X25519 key, the PC's commitment, remote2 with the phone's nonce and signature, the PC's nonce and signature, the
// 4-digit code both screens show, then remote3 waits until the person accepts on the PC – the accepted answer carries
// the phone's device token (sealed by the meeting server request). Never: trusts a PC whose key is not the one found
// under the Remote ID, or an acceptance without the session key's MAC.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class RemotePair {
    /** One sealed request step to the PC and its opened reply. */
    public interface Transport { Map<String, Object> send(Map<String, Object> body, long timeoutMs) throws IOException; }

    public static final String ROLE = "phone";
    private static final long STEP_MS = 20_000;
    private static final long WAIT_MS = 70_000;

    /** What the phone shows while the person compares the code on the PC. */
    public static final class Asked {
        public final String code;
        public final String pcName;
        public final String pcDeviceId;
        final String session;
        final byte[] key;
        final byte[] transcript;
        final Map<String, Object> pcInfo;
        Asked(String code, String pcName, String pcDeviceId, String session, byte[] key, byte[] transcript, Map<String, Object> pcInfo) {
            this.code = code; this.pcName = pcName; this.pcDeviceId = pcDeviceId; this.session = session; this.key = key; this.transcript = transcript; this.pcInfo = pcInfo;
        }
    }

    /** The accepted answer: the device token and id this PC gave the phone. */
    public static final class Accepted {
        public final String token;
        public final String deviceId;
        Accepted(String token, String deviceId) { this.token = token; this.deviceId = deviceId; }
    }

    private final Transport transport;
    private final byte[] seed;
    private final Map<String, Object> info;

    /** `deviceId` "dev_…" and `name` (≤ 60 characters) as the PC will store them; `seed` the phone's Ed25519 key. */
    public RemotePair(Transport transport, byte[] seed, String deviceId, String name) {
        this.transport = transport;
        this.seed = seed;
        String label = name == null ? "" : name.replaceAll("[\\p{Cntrl}]", " ").trim();
        if (label.length() > 60) label = label.substring(0, 60).trim();
        this.info = Json.map("id", deviceId, "name", label.isEmpty() ? "Android phone" : label, "role", "client",
                "pub", Crypto.b64url(Crypto.ed25519Public(seed)), "addresses", new ArrayList<Object>());
    }

    /** A new device id the PC accepts (dev_ + 20 base-36 characters). */
    public static String newDeviceId() {
        StringBuilder out = new StringBuilder("dev_");
        String digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        for (byte b : Crypto.random(20)) out.append(digits.charAt((b & 0xff) % 36));
        return out.toString();
    }

    /** remote1 and remote2: the code both screens show. `pcFingerprint`: the key found under the Remote ID. */
    public Asked ask(String remoteId, String pcFingerprint) throws IOException {
        byte[][] eph = Crypto.x25519Pair();
        Map<String, Object> first = step(Json.map("kind", "remote1", "v", 1, "role", ROLE, "device", info, "eph", Crypto.b64url(eph[1]),
                "target", Json.map("remoteId", remoteId)), STEP_MS);
        Object device = first.get("device");
        String session = Json.str(first, "session");
        String commit = Json.str(first, "commit");
        byte[] ephA = bytes(Json.str(first, "eph"), 32);
        if (!(device instanceof Map) || session == null || commit == null || ephA == null) throw new IOException("Update Autark on the PC.");
        @SuppressWarnings("unchecked") Map<String, Object> pc = (Map<String, Object>) device;
        byte[] pcPub = bytes(Json.str(pc, "pub"), 32);
        if (pcPub == null || !Crypto.fingerprint(pcPub).equals(pcFingerprint)) throw new IOException("A different PC answered than the one with this Remote ID.");
        byte[] t = transcript(pc, info, ephA, eph[1], commit, ROLE);
        byte[] nb = Crypto.random(16);
        Map<String, Object> second = step(Json.map("kind", "remote2", "session", session, "nb", Crypto.b64url(nb),
                "sig", Crypto.b64url(Crypto.sign(seed, signed("B", t)))), STEP_MS);
        byte[] na = bytes(Json.str(second, "na"), 16);
        String sig = Json.str(second, "sig");
        if (na == null || sig == null || !commitment(ephA, eph[1], na).equals(commit) || !Crypto.verify(pcPub, signed("A", t), Crypto.fromB64url(sig))) {
            throw new IOException("The PC could not prove its identity.");
        }
        byte[] key = Crypto.hkdf(Crypto.x25519(eph[0], ephA), t, "wf-remote-v1 key", 32);
        String name = Json.str(pc, "name");
        return new Asked(code(t, na, nb), name == null ? "PC" : name, Json.str(pc, "id"), session, key, t, pc);
    }

    /** remote3 until the person decides on the PC (each wait ≤ 55 s there). */
    public Accepted await(Asked asked, java.util.function.BooleanSupplier cancelled) throws IOException {
        while (!cancelled.getAsBoolean()) {
            Map<String, Object> reply = step(Json.map("kind", "remote3", "session", asked.session, "mac", mac(asked.key, "remote-wait", asked.session)), WAIT_MS);
            String status = Json.str(reply, "status");
            if ("pending".equals(status)) continue;
            if ("declined".equals(status)) { String reason = Json.str(reply, "reason"); throw new IOException(reason == null ? "The PC declined." : reason); }
            if (!"accepted".equals(status)) throw new IOException("Nobody accepted on the PC in time.");
            Object device = reply.get("device");
            String given = Json.str(reply, "mac");
            if (!(device instanceof Map) || given == null || !constantEquals(mac(asked.key, "remote-accept", device, Crypto.b64url(asked.transcript)), given)) {
                throw new IOException("The PC could not prove its identity.");
            }
            String token = Json.str(reply, "token");
            String deviceId = Json.str(reply, "deviceId");
            if (token == null || deviceId == null) throw new IOException("Update Autark on the PC.");
            return new Accepted(token, deviceId);
        }
        cancel(asked);
        throw new IOException("Cancelled.");
    }

    /** Tells the PC this request ends (≤ 3 s, errors ignored). */
    public void cancel(Asked asked) {
        try { transport.send(Json.map("kind", "remoteCancel", "session", asked.session, "mac", mac(asked.key, "remote-cancel", asked.session)), 3_000); }
        catch (IOException ignored) { /* the PC lets it expire */ }
    }

    private Map<String, Object> step(Map<String, Object> body, long timeoutMs) throws IOException {
        Map<String, Object> reply = transport.send(body, timeoutMs);
        if (Boolean.TRUE.equals(reply.get("ok"))) return reply;
        Object error = reply.get("error");
        String message = error instanceof Map ? Json.str(cast(error), "message") : null;
        throw new IOException(message == null ? "The PC refused the request." : message);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) { return (Map<String, Object>) value; }

    private static byte[] bytes(String b64, int length) {
        if (b64 == null || b64.length() > 100) return null;
        try { byte[] out = Crypto.fromB64url(b64); return out.length == length ? out : null; }
        catch (IllegalArgumentException error) { return null; }
    }

    // ------------------------------------------------------------------ remote/sas.ts and devices/pair-proof.ts, exactly

    /** sha256 over length-prefixed parts ("<length>:" + bytes each). */
    static byte[] hash(Object... parts) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (Object part : parts) {
                byte[] bytes = part instanceof byte[] ? (byte[]) part : ((String) part).getBytes(StandardCharsets.UTF_8);
                digest.update((bytes.length + ":").getBytes(StandardCharsets.US_ASCII));
                digest.update(bytes);
            }
            return digest.digest();
        } catch (GeneralSecurityException error) { throw new IllegalStateException(error); }
    }

    static String commitment(byte[] ephA, byte[] ephB, byte[] na) { return Crypto.b64url(hash("wf-remote-v1 commit", ephA, ephB, na)); }

    static byte[] transcript(Map<String, Object> a, Map<String, Object> b, byte[] ephA, byte[] ephB, String commit, String role) {
        return hash("wf-remote-v1 transcript", stable(a), stable(b), ephA, ephB, commit, role);
    }

    static String code(byte[] t, byte[] na, byte[] nb) {
        byte[] h = hash("wf-remote-v1 code", t, na, nb);
        long value = ((h[0] & 0xffL) << 24) | ((h[1] & 0xffL) << 16) | ((h[2] & 0xffL) << 8) | (h[3] & 0xffL);
        return String.format(java.util.Locale.ROOT, "%04d", value % 10_000);
    }

    static byte[] signed(String side, byte[] t) { return Crypto.concat(("wf-remote-v1 " + side + "|").getBytes(StandardCharsets.US_ASCII), t); }

    static String mac(byte[] key, String label, Object... parts) {
        StringBuilder text = new StringBuilder("wf-pair-v1|").append(label).append('|');
        for (int i = 0; i < parts.length; i++) { if (i > 0) text.append('|'); text.append(stable(parts[i])); }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return Crypto.b64url(mac.doFinal(text.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException error) { throw new IllegalStateException(error); }
    }

    /** pair-proof.ts stable(): sorted keys, JSON.stringify for every leaf. */
    static String stable(Object value) {
        StringBuilder out = new StringBuilder();
        stable(out, value);
        return out.toString();
    }

    private static void stable(StringBuilder out, Object value) {
        if (value instanceof Map) {
            List<String> keys = new ArrayList<>();
            for (Object key : ((Map<?, ?>) value).keySet()) keys.add(String.valueOf(key));
            Collections.sort(keys); // JS sort(): UTF-16 code unit order, as String.compareTo
            out.append('{');
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) out.append(',');
                quote(out, keys.get(i));
                out.append(':');
                stable(out, ((Map<?, ?>) value).get(keys.get(i)));
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            List<?> list = (List<?>) value;
            for (int i = 0; i < list.size(); i++) { if (i > 0) out.append(','); stable(out, list.get(i)); }
            out.append(']');
        } else if (value instanceof String) quote(out, (String) value);
        else out.append(Json.write(value));
    }

    /** JSON.stringify of a string (ES2019 well-formed: lone surrogates escaped). */
    private static void quote(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    boolean high = Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1));
                    boolean low = Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(text.charAt(i - 1));
                    if (c < 0x20 || (Character.isSurrogate(c) && !high && !low)) out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }

    private static boolean constantEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.US_ASCII), b.getBytes(StandardCharsets.US_ASCII));
    }
}
