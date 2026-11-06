// Owns: how a swipe moves like a finger – a light curve (a quadratic Bézier whose bend is a few percent of the way, to a
// random side), start and end a few pixels off, and a duration varied around the asked one. Pure Java (host-tested);
// UseService turns the points into a GestureDescription path. Never: leaves the screen.
package com.teydralab.autark.android.phoneuse;

import java.util.Random;

public final class Gestures {
    /** Points along one path (x, y pairs) and its duration. */
    public static final class Stroke {
        public final float[] points;
        public final long durationMs;
        Stroke(float[] points, long durationMs) { this.points = points; this.durationMs = durationMs; }
    }

    static final int STEPS = 16;

    private Gestures() {}

    /** A finger-like swipe from (x1, y1) to (x2, y2) on a screen of `width`×`height`, about `durationMs` long. */
    public static Stroke swipe(float x1, float y1, float x2, float y2, long durationMs, int width, int height, Random random) {
        float dx = x2 - x1, dy = y2 - y1;
        float length = (float) Math.hypot(dx, dy);
        float jitter = Math.min(6f, length * 0.02f);
        float sx = clamp(x1 + gauss(random) * jitter, width), sy = clamp(y1 + gauss(random) * jitter, height);
        float ex = clamp(x2 + gauss(random) * jitter, width), ey = clamp(y2 + gauss(random) * jitter, height);
        // the bend: a few percent of the length, perpendicular to the way, to one side
        float bend = length * (0.04f + random.nextFloat() * 0.06f) * (random.nextBoolean() ? 1 : -1);
        float nx = length == 0 ? 0 : -dy / length, ny = length == 0 ? 0 : dx / length;
        float cx = (sx + ex) / 2 + nx * bend, cy = (sy + ey) / 2 + ny * bend;
        float[] points = new float[(STEPS + 1) * 2];
        for (int i = 0; i <= STEPS; i++) {
            float t = ease((float) i / STEPS);
            float a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
            points[i * 2] = clamp(a * sx + b * cx + c * ex, width);
            points[i * 2 + 1] = clamp(a * sy + b * cy + c * ey, height);
        }
        long asked = Math.max(80, Math.min(10_000, durationMs));
        long duration = Math.max(80, Math.round(asked * (0.85 + random.nextDouble() * 0.3)));
        return new Stroke(points, duration);
    }

    /** A tap's press: a few pixels off the point and 50–120 ms long. */
    public static Stroke tap(float x, float y, int width, int height, Random random) {
        float[] points = { clamp(x + gauss(random) * 1.5f, width), clamp(y + gauss(random) * 1.5f, height) };
        return new Stroke(points, 50 + random.nextInt(70));
    }

    /** Slow start, faster middle, slow end. */
    static float ease(float t) { return t * t * (3 - 2 * t); }

    private static float gauss(Random random) { return (float) Math.max(-2, Math.min(2, random.nextGaussian())) / 2f; }

    private static float clamp(float value, int size) { return Math.max(0, Math.min(size <= 0 ? value : size - 1, value)); }
}
