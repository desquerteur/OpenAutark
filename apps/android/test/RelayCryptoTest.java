// Owns: published test vectors for the phone's primitives (RFC 8032 Ed25519, RFC 7748 X25519, RFC 5869 HKDF), the
// Remote ID of a known PC and the JSON subset. The interop harness checks them against the PC code; this pins them alone.
// Never: claims an Android device test.
package com.teydralab.autark.android;

import com.teydralab.autark.android.relay.Crypto;
import com.teydralab.autark.android.relay.Json;
import java.util.Arrays;
import java.util.Map;

public final class RelayCryptoTest {
    private static int assertions;

    public static void main(String[] args) {
        // RFC 8032 7.1 TEST 1
        byte[] seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        equal("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", Crypto.hex(Crypto.ed25519Public(seed)));
        byte[] sig = Crypto.sign(seed, new byte[0]);
        equal("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", Crypto.hex(sig));
        check(Crypto.verify(Crypto.ed25519Public(seed), new byte[0], sig));
        sig[0] ^= 1;
        check(!Crypto.verify(Crypto.ed25519Public(seed), new byte[0], sig));
        // RFC 7748 6.1
        byte[] alice = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        byte[] bobPublic = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
        equal("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", Crypto.hex(Crypto.x25519(alice, bobPublic)));
        // RFC 5869 A.3 (the protocol's infos are ASCII, so a test case with a text info is A.3's empty one)
        byte[] okm = Crypto.hkdf(hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"), new byte[0], "", 42);
        equal("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8", Crypto.hex(okm));
        // AES-GCM counter frames open only with their own counter.
        byte[] key = Crypto.random(32);
        byte[] sealed = Crypto.seal(key, 7, Crypto.utf8("hello"));
        check(Arrays.equals(Crypto.utf8("hello"), Crypto.open(key, 7, sealed, 0, sealed.length)));
        check(Crypto.open(key, 8, sealed, 0, sealed.length) == null);
        // b64url without padding, like Node's 'base64url'
        equal("-_8", Crypto.b64url(new byte[] { (byte) 0xfb, (byte) 0xff }));
        // Remote IDs as apps/desktop/src/runtime/remote/id.ts computes them (values from that code, 05.11.2026)
        equal("114875446", Crypto.remoteId("0000000000000000000000000000000000000000000000000000000000000000"));
        equal("552774309", Crypto.remoteId("81f39bf2061bf1c90aa791641ecf949f794ec5eae41a1185ab04e58ca2e6e9a5"));
        // JSON subset
        Map<String, Object> value = Json.object("{\"t\":\"x\",\"n\":3,\"a\":[1,\"\\u00e4\\n\"],\"b\":true,\"z\":null}");
        equal("x", Json.str(value, "t"));
        check(Json.num(value, "n", -1) == 3);
        equal("{\"t\":\"x\",\"n\":3,\"a\":[1,\"ä\\n\"],\"b\":true,\"z\":null}", Json.write(value));
        System.out.println(assertions + " relay crypto/JSON assertions passed.");
    }

    private static byte[] hex(String text) {
        byte[] out = new byte[text.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(text.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("check failed"); }
    private static void equal(String expected, String actual) { assertions++; if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual); }
}
