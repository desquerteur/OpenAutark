// Owns: host checks of phone use's pure parts – the flattened screen tree (order, parents, invisible nodes left out, no
// password text, short class names), the element a tap means, and the finger-like swipe (curved, on screen, about the
// asked duration). Never: an Android device test (UseService itself needs a phone).
package com.teydralab.autark.android.phoneuse;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Random;

public final class ScreenTreeTest {
    private static int assertions;

    static final class Fake implements ScreenTree.Node {
        final String cls; final String text; final int[] bounds; final boolean visible; final boolean clickable; final boolean password;
        final List<ScreenTree.Node> children = new ArrayList<>();
        Fake(String cls, String text, int[] bounds, boolean visible, boolean clickable, boolean password, ScreenTree.Node... kids) {
            this.cls = cls; this.text = text; this.bounds = bounds; this.visible = visible; this.clickable = clickable; this.password = password;
            children.addAll(Arrays.asList(kids));
        }
        @Override public CharSequence text() { return text; }
        @Override public CharSequence desc() { return null; }
        @Override public String id() { return null; }
        @Override public CharSequence cls() { return cls; }
        @Override public CharSequence pkg() { return "com.example"; }
        @Override public int[] bounds() { return bounds; }
        @Override public boolean visible() { return visible; }
        @Override public boolean clickable() { return clickable; }
        @Override public boolean scrollable() { return false; }
        @Override public boolean checkable() { return false; }
        @Override public boolean checked() { return false; }
        @Override public boolean enabled() { return true; }
        @Override public boolean focused() { return false; }
        @Override public boolean selected() { return false; }
        @Override public boolean password() { return password; }
        @Override public int childCount() { return children.size(); }
        @Override public ScreenTree.Node child(int index) { return children.get(index); }
    }

    public static void main(String[] args) {
        Fake send = new Fake("android.widget.Button", "Send", new int[] {100, 200, 300, 260}, true, true, false);
        Fake card = new Fake("android.widget.LinearLayout", null, new int[] {0, 150, 1080, 400}, true, true, false, send);
        Fake hidden = new Fake("android.widget.TextView", "secret banner", new int[] {0, 0, 10, 10}, false, false, false);
        Fake pin = new Fake("android.widget.EditText", "1234", new int[] {0, 500, 1080, 600}, true, true, true);
        Fake root = new Fake("android.widget.FrameLayout", null, new int[] {0, 0, 1080, 2400}, true, false, false, card, hidden, pin);
        List<ScreenTree.Node> visited = new ArrayList<>();
        List<Map<String, Object>> rows = ScreenTree.flatten(root, visited);
        equal(4, rows.size());
        equal(4, visited.size());
        equal("FrameLayout", rows.get(0).get("cls"));
        equal(-1, rows.get(0).get("parent"));
        equal(0, rows.get(1).get("parent"));
        equal(1, rows.get(2).get("parent"));
        equal(2, rows.get(2).get("depth"));
        equal("Send", rows.get(2).get("text"));
        check(!rows.get(3).containsKey("text"));
        equal(true, rows.get(3).get("password"));
        check(visited.get(2) == send);
        equal(2, ScreenTree.clickableAt(rows, 150, 230));
        equal(1, ScreenTree.clickableAt(rows, 500, 300));
        equal(-1, ScreenTree.clickableAt(rows, 500, 1000));

        Random random = new Random(7);
        for (int run = 0; run < 50; run++) {
            Gestures.Stroke stroke = Gestures.swipe(540, 1800, 540, 600, 400, 1080, 2400, random);
            check(stroke.durationMs >= 330 && stroke.durationMs <= 470);
            float maxOff = 0;
            for (int i = 0; i < stroke.points.length; i += 2) {
                check(stroke.points[i] >= 0 && stroke.points[i] < 1080 && stroke.points[i + 1] >= 0 && stroke.points[i + 1] < 2400);
                maxOff = Math.max(maxOff, Math.abs(stroke.points[i] - 540));
            }
            check(maxOff > 10 && maxOff < 120); // a light curve, not a straight line or a detour
            check(Math.abs(stroke.points[stroke.points.length - 1] - 600) <= 6);
        }
        Gestures.Stroke tap = Gestures.tap(0, 0, 1080, 2400, random);
        check(tap.points[0] >= 0 && tap.points[1] >= 0 && tap.durationMs >= 50 && tap.durationMs < 120);
        System.out.println(assertions + " phone use (tree, tap target, gestures) assertions passed.");
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("check failed"); }
    private static void equal(Object expected, Object actual) { assertions++; if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual); }
}
