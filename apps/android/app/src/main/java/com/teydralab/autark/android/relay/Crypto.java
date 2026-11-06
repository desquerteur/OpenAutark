// Owns: the exact primitives Autark's PCs use for the meeting server and the peer channel (Ed25519 device keys,
// X25519, HKDF-SHA256, AES-256-GCM with counter nonces, base64url without padding), byte for byte as
// apps/desktop/src/runtime/devices/{keys,handshake,channel}.ts and rendezvous/seal.ts. Never: stores keys or logs them.
package com.teydralab.autark.android.relay;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.math.ec.rfc7748.X25519;
import org.bouncycastle.math.ec.rfc8032.Ed25519;

public final class Crypto {
    public static final SecureRandom RANDOM = new SecureRandom();

    private Crypto() {}

    public static String b64url(byte[] data) { return Base64.getUrlEncoder().withoutPadding().encodeToString(data); }

    /** Standard base64 with padding (HTTP headers, the PC's stream bytes). */
    public static String b64urlStd(byte[] data) { return Base64.getEncoder().encodeToString(data); }

    public static byte[] fromB64url(String text) { return Base64.getUrlDecoder().decode(text.replace("=", "")); }

    public static byte[] utf8(String text) { return text.getBytes(StandardCharsets.UTF_8); }

    public static byte[] random(int length) {
        byte[] out = new byte[length];
        RANDOM.nextBytes(out);
        return out;
    }

    public static byte[] concat(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        int at = 0;
        for (byte[] part : parts) { System.arraycopy(part, 0, out, at, part.length); at += part.length; }
        return out;
    }

    public static byte[] sha256(byte[] data) {
        try { return MessageDigest.getInstance("SHA-256").digest(data); }
        catch (GeneralSecurityException error) { throw new IllegalStateException(error); }
    }

    public static String hex(byte[] data) {
        StringBuilder out = new StringBuilder();
        for (byte b : data) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }

    /** The device fingerprint: sha256 (hex) of the raw Ed25519 public key. */
    public static String fingerprint(byte[] publicKey) { return hex(sha256(publicKey)); }

    /** The 9-digit Remote ID of a fingerprint (remote/id.ts): 8 digits from a hash plus a Luhn check digit. */
    public static String remoteId(String fingerprint) {
        byte[] digest = sha256(utf8("wf-remote-id-v1|" + fingerprint.toLowerCase(java.util.Locale.ROOT)));
        long high = ((digest[0] & 0xffL) << 24) | ((digest[1] & 0xffL) << 16) | ((digest[2] & 0xffL) << 8) | (digest[3] & 0xffL);
        String all = String.format(java.util.Locale.ROOT, "%010d", high * 4 + (digest[4] & 3));
        String payload = all.substring(all.length() - 8);
        int sum = 0;
        for (int i = 0; i < payload.length(); i++) {
            int digit = payload.charAt(payload.length() - 1 - i) - '0';
            if (i % 2 == 0) { digit *= 2; if (digit > 9) digit -= 9; }
            sum += digit;
        }
        return payload + ((10 - (sum % 10)) % 10);
    }

    // ------------------------------------------------------------------ Ed25519 device key

    public static byte[] newSeed() { return random(32); }

    public static byte[] ed25519Public(byte[] seed) {
        byte[] out = new byte[32];
        Ed25519.generatePublicKey(seed, 0, out, 0);
        return out;
    }

    public static byte[] sign(byte[] seed, byte[] message) {
        byte[] out = new byte[64];
        Ed25519.sign(seed, 0, message, 0, message.length, out, 0);
        return out;
    }

    public static boolean verify(byte[] publicKey, byte[] message, byte[] signature) {
        if (publicKey == null || publicKey.length != 32 || signature == null || signature.length != 64) return false;
        try { return Ed25519.verify(signature, 0, publicKey, 0, message, 0, message.length); }
        catch (RuntimeException error) { return false; }
    }

    // ------------------------------------------------------------------ X25519

    /** A fresh X25519 pair: [0] private, [1] public. */
    public static byte[][] x25519Pair() {
        byte[] secret = new byte[32];
        X25519.generatePrivateKey(RANDOM, secret);
        byte[] pub = new byte[32];
        X25519.generatePublicKey(secret, 0, pub, 0);
        return new byte[][] { secret, pub };
    }

    public static byte[] x25519(byte[] secret, byte[] peerPublic) {
        if (peerPublic == null || peerPublic.length != 32) throw new IllegalArgumentException("bad key");
        byte[] out = new byte[32];
        if (!X25519.calculateAgreement(secret, 0, peerPublic, 0, out, 0)) throw new IllegalArgumentException("weak key");
        return out;
    }

    // ------------------------------------------------------------------ HKDF and AES-GCM

    public static byte[] hkdf(byte[] ikm, byte[] salt, String info, int length) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(salt.length == 0 ? new byte[32] : salt, "HmacSHA256"));
            byte[] prk = mac.doFinal(ikm);
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            byte[] out = new byte[length];
            byte[] previous = new byte[0];
            int at = 0;
            for (int i = 1; at < length; i++) {
                mac.update(previous);
                mac.update(utf8(info));
                mac.update((byte) i);
                previous = mac.doFinal();
                int take = Math.min(previous.length, length - at);
                System.arraycopy(previous, 0, out, at, take);
                at += take;
            }
            return out;
        } catch (GeneralSecurityException error) { throw new IllegalStateException(error); }
    }

    static byte[] nonce(long counter) {
        byte[] out = new byte[12];
        for (int i = 0; i < 8; i++) out[4 + i] = (byte) (counter >>> (56 - 8 * i));
        return out;
    }

    public static byte[] seal(byte[] key, long counter, byte[] plain) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce(counter)));
            return cipher.doFinal(plain);
        } catch (GeneralSecurityException error) { throw new IllegalStateException(error); }
    }

    /** The plain bytes, or null when the frame does not open with this key and counter. */
    public static byte[] open(byte[] key, long counter, byte[] sealed, int offset, int length) {
        if (length < 16) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce(counter)));
            return cipher.doFinal(sealed, offset, length);
        } catch (GeneralSecurityException error) { return null; }
    }
}
