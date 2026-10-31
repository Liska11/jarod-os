package os.jarod.mobile;

import java.util.List;

/** What the screen reader keeps and how big a capture may be, apart from Android so it is tested. */
final class ScreenRules {

    static final int MAX_TEXT = 6000;
    static final int MAX_SIDE = 1600;

    private ScreenRules() {}

    /**
     * The screen's pieces of text as one block: empty pieces dropped, a piece that repeats the one
     * before it (a label and its description) kept once, cut at `max` characters with an ellipsis.
     */
    static String join(List<String> parts, int max) {
        StringBuilder out = new StringBuilder();
        String last = null;
        for (String raw : parts) {
            if (raw == null) continue;
            String p = raw.replaceAll("\\s+", " ").trim();
            if (p.isEmpty() || p.equals(last)) continue;
            last = p;
            if (out.length() > 0) out.append('\n');
            out.append(p);
            if (out.length() > max) break;
        }
        if (out.length() <= max) return out.toString();
        return out.substring(0, Math.max(0, max - 1)).trim() + "…";
    }

    /**
     * Whether `enabledServices` (the system's colon-separated list, Settings.Secure
     * enabled_accessibility_services) holds our service, written in full or with the short ".Class".
     */
    static boolean isEnabled(String enabledServices, String pkg, String cls) {
        if (enabledServices == null || enabledServices.isEmpty()) return false;
        String shortCls = cls.startsWith(pkg + ".") ? cls.substring(pkg.length()) : cls;
        for (String entry : enabledServices.split(":")) {
            String e = entry.trim();
            if (e.equals(pkg + "/" + cls) || e.equals(pkg + "/" + shortCls)) return true;
        }
        return false;
    }

    /** The size a capture is scaled to so its longer side is at most `maxSide`; never enlarged. Returns {w, h}. */
    static int[] fit(int w, int h, int maxSide) {
        int longest = Math.max(w, h);
        if (longest <= maxSide || longest <= 0) return new int[] {w, h};
        float k = (float) maxSide / longest;
        return new int[] {Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))};
    }
}
