package os.jarod.mobile;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * Reads the screen of the app behind Jarod's assistant, only when the owner asks in the chat and
 * confirms with their fingerprint (src/screens/ChatView.tsx). It reacts to no event, never taps,
 * types or swipes for anyone, skips password fields, and keeps nothing. The service config asks for
 * no gesture ability at all: the system would refuse one.
 */
public class JarodAccessibilityService extends AccessibilityService {

    /** What a failed capture tells the page (the system's refusal codes are not for the owner). */
    interface ShotCallback {
        void done(String jpegBase64, String error);
    }

    private static final int MAX_NODES = 3000;
    private static final int MAX_DEPTH = 60;

    private static volatile JarodAccessibilityService live;

    /** The connected service, or null while the owner has not switched it on in the system. */
    static JarodAccessibilityService connected() {
        return live;
    }

    @Override
    protected void onServiceConnected() {
        live = this;
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        if (live == this) live = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    /** A window and its root, fetched once: the app the assistant was opened over. */
    private static final class Target {
        final AccessibilityWindowInfo window;
        final AccessibilityNodeInfo root;

        Target(AccessibilityWindowInfo window, AccessibilityNodeInfo root) {
            this.window = window;
            this.root = root;
        }
    }

    /** Nodes are pooled before Android 13 and must be given back; from 13 the system does it. */
    @SuppressWarnings("deprecation")
    private static void release(AccessibilityNodeInfo node) {
        if (node != null && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) node.recycle();
    }

    /** The topmost application window that is not Jarod's own, with its root; null when there is none. */
    private Target otherAppTarget() {
        List<AccessibilityWindowInfo> windows = getWindows();
        Target best = null;
        for (AccessibilityWindowInfo w : windows) {
            if (w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo root = w.getRoot();
            if (root == null) continue;
            boolean ours = getPackageName().contentEquals(root.getPackageName() == null ? "" : root.getPackageName());
            if (ours || (best != null && w.getLayer() <= best.window.getLayer())) {
                release(root);
                continue;
            }
            if (best != null) release(best.root);
            best = new Target(w, root);
        }
        return best;
    }

    /** The visible text of that window, or null when there is no other app to read. */
    String screenText() {
        Target t = otherAppTarget();
        if (t == null) return null;
        try {
            List<String> parts = new ArrayList<>();
            collect(t.root, parts, new int[] {0}, 0);
            return ScreenRules.join(parts, ScreenRules.MAX_TEXT);
        } finally {
            release(t.root);
        }
    }

    private void collect(AccessibilityNodeInfo node, List<String> parts, int[] seen, int depth) {
        if (node == null || depth > MAX_DEPTH || seen[0]++ > MAX_NODES || !node.isVisibleToUser()) return;
        // A password field's text is never read, whatever the screen.
        if (!node.isPassword()) {
            CharSequence text = node.getText();
            if (text != null && text.length() > 0) parts.add(text.toString());
            else if (node.getContentDescription() != null) parts.add(node.getContentDescription().toString());
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            collect(child, parts, seen, depth + 1);
            release(child);
        }
    }

    /**
     * A JPEG of that window alone (Android 14+: the system captures one window, so Jarod's own sheet
     * is not in it). A window that forbids capture (FLAG_SECURE: banking, passwords) comes back as an error.
     */
    void screenshot(ShotCallback cb) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            cb.done(null, "La capture d’écran demande Android 14 ou plus.");
            return;
        }
        Target target = otherAppTarget();
        if (target == null) {
            cb.done(null, "Aucune autre appli à capturer.");
            return;
        }
        int windowId = target.window.getId();
        release(target.root);
        takeScreenshotOfWindow(windowId, Executors.newSingleThreadExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult result) {
                HardwareBuffer buffer = result.getHardwareBuffer();
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                    if (hw == null) {
                        cb.done(null, "Capture illisible.");
                        return;
                    }
                    Bitmap soft = hw.copy(Bitmap.Config.ARGB_8888, false);
                    int[] size = ScreenRules.fit(soft.getWidth(), soft.getHeight(), ScreenRules.MAX_SIDE);
                    Bitmap scaled = size[0] == soft.getWidth() ? soft : Bitmap.createScaledBitmap(soft, size[0], size[1], true);
                    ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
                    scaled.compress(Bitmap.CompressFormat.JPEG, 75, jpeg);
                    cb.done(Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP), null);
                } finally {
                    buffer.close();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                cb.done(null, errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW ? "Cette appli interdit les captures d’écran." : "Capture impossible.");
            }
        });
    }
}
