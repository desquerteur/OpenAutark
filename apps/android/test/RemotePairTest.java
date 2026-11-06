// Owns: the phone's connect-request math against vectors the desktop's own remote/sas.ts and devices/pair-proof.ts
// printed (B-078, 06.11.2026) – stable JSON, commitment, transcript, the 4-digit code and the MACs – so both sides reach
// the same code. Never: a network test (the interop harness and a real device do that).
package com.teydralab.autark.android.relay;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

public final class RemotePairTest {
    private static int assertions;

    public static void main(String[] args) {
        List<Object> addresses = new ArrayList<>(Arrays.asList("http://192.168.1.2:47812", "relay:x"));
        Map<String, Object> a = Json.map("id", "dev_pc00000000001", "name", "Büro-PC \"Nord\"\b\f", "role", "home", "pub", repeat('A', 43), "addresses", addresses);
        Map<String, Object> b = Json.map("id", "dev_phone00000001", "name", "Pixel 8 😀", "role", "client", "pub", repeat('B', 43), "addresses", new ArrayList<Object>());
        byte[] ephA = fill(32, 1), ephB = fill(32, 2), na = fill(16, 3), nb = fill(16, 4);
        equal("{\"addresses\":[\"http://192.168.1.2:47812\",\"relay:x\"],\"id\":\"dev_pc00000000001\",\"name\":\"Büro-PC \\\"Nord\\\"\\b\\f\",\"pub\":\"" + repeat('A', 43) + "\",\"role\":\"home\"}", RemotePair.stable(a));
        String commit = RemotePair.commitment(ephA, ephB, na);
        equal("n3COWC9UlCCqDOpIne6s5D01wBTN6IurBDoqNCHoGm4", commit);
        byte[] t = RemotePair.transcript(a, b, ephA, ephB, commit, "phone");
        equal("1db4ffb7d7e36cbf29572f5eb12ae9df9a2940aaf41059658ddc538c1c783001", Crypto.hex(t));
        equal("8629", RemotePair.code(t, na, nb));
        equal("30e2N-SIxf7uJVX2uehSOYY4OYeC8rTIEb9xP9Dn_xY", RemotePair.mac(fill(32, 5), "remote-accept", a, Crypto.b64url(t)));
        equal("PTqd7ef_lYKBJOEU4Edkrk2Gi6e3T9SYRT8MwDY96NI", RemotePair.mac(fill(32, 5), "remote-wait", "sess"));
        equal("77662d72656d6f74652d763120427c1db4ffb7d7", Crypto.hex(RemotePair.signed("B", t)).substring(0, 40));
        String id = RemotePair.newDeviceId();
        check(id.matches("dev_[0-9a-z]{20}"));
        System.out.println(assertions + " phone pairing (SAS) assertions passed.");
    }

    private static String repeat(char c, int n) { char[] out = new char[n]; Arrays.fill(out, c); return new String(out); }
    private static byte[] fill(int n, int value) { byte[] out = new byte[n]; Arrays.fill(out, (byte) value); return out; }
    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("check failed"); }
    private static void equal(String expected, String actual) { assertions++; if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual); }
}
