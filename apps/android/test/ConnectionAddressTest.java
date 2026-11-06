// Owns: executable checks of the connect screen's input rules (the Remote ID typed or as the QR's pair link) and the
// local origin, without an Android device. Never: claims WebView acceptance.
package com.teydralab.autark.android;

public final class ConnectionAddressTest {
    private static int assertions;

    public static void main(String[] args) {
        equal("482913071", ConnectionAddress.remoteId(" 482 913 071 "));
        equal("482913071", ConnectionAddress.remoteId("482-913-071"));
        equal("482913071", ConnectionAddress.remoteId("https://metajarvis.teydralab.com/autark/pair#482913071"));
        equal("482913071", ConnectionAddress.fromLink("https://metajarvis.teydralab.com/autark/pair#482913071"));
        equal("482913071", ConnectionAddress.remoteId("https://metajarvis.teydralab.com/autark/pair/#482913071"));
        equal("482913071", ConnectionAddress.fromLink("https://metajarvis.teydralab.com/autark/pair/#482913071"));
        check(ConnectionAddress.fromLink("https://evil.test/autark/pair#482913071") == null);
        check(ConnectionAddress.fromLink("https://metajarvis.teydralab.com/autark/pair#12") == null);
        check(ConnectionAddress.fromLink(null) == null);
        for (String invalid : new String[] {"", "12345678", "1234567890", "abcdefghi", "48291307x", "https://x/pair#1234"}) rejects(() -> ConnectionAddress.remoteId(invalid));
        check(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://127.0.0.1:47920/#/chat/x"));
        check(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://127.0.0.1:47920/ws"));
        check(!ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://127.0.0.1:47921/"));
        check(!ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "https://127.0.0.1:47920/"));
        check(!ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://localhost:47920/"));
        check(!ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://127.0.0.1:47920@evil.test/"));
        check(!ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "about:blank"));
        check(!ConnectionAddress.sameOrigin("http://127.0.0.1:47920", null));
        check(!ConnectionAddress.sameOrigin(null, "http://127.0.0.1:47920/"));
        System.out.println(assertions + " connection input/origin assertions passed.");
    }

    private static void rejects(Runnable action) {
        try { action.run(); throw new AssertionError("Accepted invalid input"); }
        catch (IllegalArgumentException expected) { assertions++; }
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Unexpected result"); }
    private static void equal(String expected, String actual) { assertions++; if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual); }
}
