package os.jarod.mobile;

/**
 * A one-use, short-lived proof that the owner just passed the fingerprint for reading the screen
 * (DeviceVaultPlugin.confirm with purpose "screen"). JarodAccessibilityPlugin consumes it, so a script
 * in the page cannot read the screen without the prompt having been answered just before.
 */
final class ConfirmGate {

    static final long WINDOW_MS = 30_000;

    /** 0 = no proof outstanding. Times are SystemClock.elapsedRealtime(), never 0 in practice. */
    private static long grantedAt = 0;

    private ConfirmGate() {}

    static synchronized void grant(long nowMs) {
        grantedAt = nowMs;
    }

    /** True once per grant, and only within WINDOW_MS of it. */
    static synchronized boolean consume(long nowMs) {
        long age = nowMs - grantedAt;
        boolean ok = grantedAt != 0 && age >= 0 && age <= WINDOW_MS;
        grantedAt = 0;
        return ok;
    }
}
