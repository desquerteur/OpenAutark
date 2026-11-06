// Owns: the screen as an agent reads it – the accessibility tree flattened in document order into the node rows the PC's
// phone tools render (apps/desktop/src/runtime/phone/uiautomator.ts PhoneNode: depth, parent, text, desc, id, cls, pkg,
// bounds, clickable, scrollable, checkable, checked, enabled, focused, selected, password), invisible nodes left out,
// at most MAX nodes; and which element a tap at a point means (the smallest clickable one around it). Pure Java over a
// small Node view, so it runs in host tests (test/phoneuse/ScreenTreeTest.java). Never: reads a password field's text.
package com.teydralab.autark.android.phoneuse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ScreenTree {
    public static final int MAX = 1500;

    /** What the tree needs of one accessibility node (UseService wraps AccessibilityNodeInfo). */
    public interface Node {
        CharSequence text();
        CharSequence desc();
        String id();
        CharSequence cls();
        CharSequence pkg();
        /** left, top, right, bottom in screen pixels. */
        int[] bounds();
        boolean visible();
        boolean clickable();
        boolean scrollable();
        boolean checkable();
        boolean checked();
        boolean enabled();
        boolean focused();
        boolean selected();
        boolean password();
        int childCount();
        /** null when the child is gone. */
        Node child(int index);
    }

    private ScreenTree() {}

    /** The rows of the tree under `root`, document order; parents point at the row index of their parent. */
    public static List<Map<String, Object>> flatten(Node root) { return flatten(root, null); }

    /** The same; `visited` (when given) gets each row's node at the row's index (a tap clicks that node). */
    public static List<Map<String, Object>> flatten(Node root, List<Node> visited) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (root != null) walk(root, -1, 0, out, visited);
        return out;
    }

    private static void walk(Node node, int parent, int depth, List<Map<String, Object>> out, List<Node> visited) {
        if (out.size() >= MAX || depth > 60) return;
        if (!node.visible() && parent >= 0) return;
        int index = out.size();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("depth", depth);
        row.put("parent", parent);
        boolean password = node.password();
        put(row, "text", password ? null : node.text());
        put(row, "desc", node.desc());
        put(row, "id", node.id());
        put(row, "cls", shortClass(node.cls()));
        put(row, "pkg", node.pkg());
        int[] b = node.bounds();
        if (b != null && b.length == 4 && b[2] > b[0] && b[3] > b[1]) {
            List<Object> bounds = new ArrayList<>();
            for (int v : b) bounds.add(v);
            row.put("bounds", bounds);
        }
        flag(row, "clickable", node.clickable());
        flag(row, "scrollable", node.scrollable());
        if (node.checkable()) { row.put("checkable", true); row.put("checked", node.checked()); }
        if (!node.enabled()) row.put("enabled", false);
        flag(row, "focused", node.focused());
        flag(row, "selected", node.selected());
        flag(row, "password", password);
        out.add(row);
        if (visited != null) visited.add(node);
        for (int i = 0; i < node.childCount(); i++) {
            Node child = node.child(i);
            if (child != null) walk(child, index, depth + 1, out, visited);
        }
    }

    /** "android.widget.Button" → "Button". */
    static String shortClass(CharSequence cls) {
        if (cls == null) return null;
        String name = cls.toString();
        int dot = name.lastIndexOf('.');
        return dot >= 0 ? name.substring(dot + 1) : name;
    }

    private static void put(Map<String, Object> row, String key, Object value) {
        if (value == null) return;
        String text = value.toString();
        if (text.isEmpty()) return;
        row.put(key, text.length() > 300 ? text.substring(0, 300) : text);
    }

    private static void flag(Map<String, Object> row, String key, boolean value) { if (value) row.put(key, true); }

    /** The row index of the smallest clickable element around (x, y), -1 when none: a tap then clicks it instead of a gesture. */
    @SuppressWarnings("unchecked")
    public static int clickableAt(List<Map<String, Object>> rows, int x, int y) {
        int best = -1;
        long bestArea = Long.MAX_VALUE;
        for (int i = 0; i < rows.size(); i++) {
            Map<String, Object> row = rows.get(i);
            if (!Boolean.TRUE.equals(row.get("clickable")) || Boolean.FALSE.equals(row.get("enabled"))) continue;
            Object bounds = row.get("bounds");
            if (!(bounds instanceof List)) continue;
            List<Object> b = (List<Object>) bounds;
            int l = (Integer) b.get(0), t = (Integer) b.get(1), r = (Integer) b.get(2), btm = (Integer) b.get(3);
            if (x < l || x >= r || y < t || y >= btm) continue;
            long area = (long) (r - l) * (btm - t);
            if (area < bestArea) { bestArea = area; best = i; }
        }
        return best;
    }
}
