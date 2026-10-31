package os.jarod.mobile;

/** Where the floating bubble may sit, and what counts as a tap rather than a drag. Pure, so it is tested. */
final class OrbGeometry {

    private OrbGeometry() {}

    static int clamp(int v, int min, int max) {
        if (max < min) return min;
        return Math.max(min, Math.min(max, v));
    }

    /** A finger that stayed within `slop` pixels of where it landed tapped; further away, it dragged. */
    static boolean isTap(float dx, float dy, float slop) {
        return dx * dx + dy * dy <= slop * slop;
    }

    /**
     * Where a dropped bubble comes to rest: against the nearer side edge, and kept between the top
     * and bottom margins so it never hides under the status or navigation bar. Returns {x, y}.
     */
    static int[] settle(int x, int y, int size, int screenW, int screenH, int marginTop, int marginBottom) {
        int right = Math.max(0, screenW - size);
        int snappedX = (x + size / 2) < screenW / 2 ? 0 : right;
        return new int[] {snappedX, clamp(y, marginTop, screenH - size - marginBottom)};
    }
}
