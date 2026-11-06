// Owns: the small JSON subset the relay and peer protocols use (objects, arrays, strings, numbers, booleans, null).
// Never: depends on Android, so the same code runs in host tests.
package com.teydralab.autark.android.relay;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Json {
    private final String text;
    private int at;

    private Json(String text) { this.text = text; }

    /** Parses a JSON value; throws IllegalArgumentException when it is not JSON. */
    public static Object parse(String text) {
        Json parser = new Json(text);
        parser.space();
        Object value = parser.value(0);
        parser.space();
        if (parser.at != text.length()) throw new IllegalArgumentException("trailing data");
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(String text) {
        Object value = parse(text);
        if (!(value instanceof Map)) throw new IllegalArgumentException("not an object");
        return (Map<String, Object>) value;
    }

    public static String str(Map<String, Object> map, String key) {
        Object value = map.get(key);
        return value instanceof String ? (String) value : null;
    }

    public static long num(Map<String, Object> map, String key, long fallback) {
        Object value = map.get(key);
        if (!(value instanceof Double)) return fallback;
        double number = (Double) value;
        return number == Math.rint(number) ? (long) number : fallback;
    }

    public static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) out.put((String) pairs[i], pairs[i + 1]);
        return out;
    }

    public static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value) {
        if (value == null) out.append("null");
        else if (value instanceof String) quote(out, (String) value);
        else if (value instanceof Boolean) out.append(value);
        else if (value instanceof Integer || value instanceof Long) out.append(value);
        else if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (number == Math.rint(number) && Math.abs(number) < 9e15) out.append((long) number);
            else out.append(number);
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                quote(out, String.valueOf(entry.getKey()));
                out.append(':');
                write(out, entry.getValue());
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) out.append(',');
                first = false;
                write(out, item);
            }
            out.append(']');
        } else throw new IllegalArgumentException("not JSON: " + value.getClass());
    }

    private static void quote(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }

    private Object value(int depth) {
        if (depth > 32) throw new IllegalArgumentException("too deep");
        if (at >= text.length()) throw new IllegalArgumentException("end of input");
        char c = text.charAt(at);
        if (c == '{') {
            at++;
            Map<String, Object> out = new LinkedHashMap<>();
            space();
            if (peek('}')) { at++; return out; }
            for (;;) {
                space();
                if (!peek('"')) throw new IllegalArgumentException("key expected");
                String key = string();
                space();
                expect(':');
                space();
                out.put(key, value(depth + 1));
                space();
                if (peek(',')) { at++; continue; }
                expect('}');
                return out;
            }
        }
        if (c == '[') {
            at++;
            List<Object> out = new ArrayList<>();
            space();
            if (peek(']')) { at++; return out; }
            for (;;) {
                space();
                out.add(value(depth + 1));
                space();
                if (peek(',')) { at++; continue; }
                expect(']');
                return out;
            }
        }
        if (c == '"') return string();
        if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
        if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
        if (text.startsWith("null", at)) { at += 4; return null; }
        int start = at;
        while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
        if (start == at) throw new IllegalArgumentException("unexpected character");
        return Double.parseDouble(text.substring(start, at));
    }

    private String string() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (at < text.length()) {
            char c = text.charAt(at++);
            if (c == '"') return out.toString();
            if (c != '\\') { out.append(c); continue; }
            if (at >= text.length()) break;
            char e = text.charAt(at++);
            switch (e) {
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u':
                    if (at + 4 > text.length()) throw new IllegalArgumentException("bad escape");
                    out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                    at += 4;
                    break;
                default: out.append(e);
            }
        }
        throw new IllegalArgumentException("unterminated string");
    }

    private void space() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }
    private boolean peek(char c) { return at < text.length() && text.charAt(at) == c; }
    private void expect(char c) {
        if (!peek(c)) throw new IllegalArgumentException("expected " + c);
        at++;
    }
}
