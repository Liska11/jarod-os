package os.jarod.mobile;

import java.util.Set;

/**
 * What the notification reader may show the owner, kept apart from Android so it is tested. The
 * rule of thumb: only what the owner chose (app by app), never our own, never what the system calls
 * ongoing or secret, and never more than a short excerpt.
 */
final class NotificationRules {

    static final int MAX_TEXT = 300;

    private NotificationRules() {}

    /**
     * `allowed` is the apps the owner ticked; null means "any app" and is only used to list the apps
     * that could be ticked.
     */
    static boolean include(String pkg, String ownPkg, boolean ongoing, boolean groupSummary, boolean secret, Set<String> allowed) {
        if (pkg == null || pkg.equals(ownPkg)) return false;
        // Ongoing: a music player, a call, a foreground service. Summary: the "3 messages" header of a group.
        if (ongoing || groupSummary || secret) return false;
        return allowed == null || allowed.contains(pkg);
    }

    /** One line of at most `max` characters: spaces collapsed, cut with an ellipsis. Never null. */
    static String clip(CharSequence s, int max) {
        if (s == null) return "";
        String t = s.toString().replaceAll("\\s+", " ").trim();
        if (t.length() <= max) return t;
        return t.substring(0, Math.max(0, max - 1)).trim() + "…";
    }

    /** A name for an app the system will not name for us (package visibility): its last package segment. */
    static String fallbackLabel(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        int dot = pkg.lastIndexOf('.');
        return dot < 0 || dot == pkg.length() - 1 ? pkg : pkg.substring(dot + 1);
    }
}
