package os.jarod.mobile;

import android.content.Context;
import android.os.Environment;
import java.io.File;

/**
 * Capacitor leaves every camera shot taken from the chat in the app's Pictures folder, for good. The
 * page has read the photo and sent it to the PC long before, so old ones are deleted: a conversation's
 * photos do not pile up on the phone.
 */
final class CaptureCleanup {

    /** Longer than any send takes, short enough that nothing lingers. */
    static final long MAX_AGE_MS = 6L * 60 * 60 * 1000;

    // Capacitor's own naming (createImageFile): nothing else in that folder is ever touched.
    private static final String PREFIX = "JPEG_";
    private static final String SUFFIX = ".jpg";

    private CaptureCleanup() {}

    /** On a thread of its own: listing a folder is disk work, and the screen is opening. */
    static void purgeInBackground(Context ctx) {
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        new Thread(() -> purge(dir, System.currentTimeMillis(), MAX_AGE_MS), "jarod-capture-cleanup").start();
    }

    /** Deletes Capacitor's camera shots in `dir` older than `maxAgeMs`; returns how many went. */
    static int purge(File dir, long nowMs, long maxAgeMs) {
        if (dir == null) return 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        int gone = 0;
        for (File f : files) {
            String name = f.getName();
            if (!f.isFile() || !name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
            if (nowMs - f.lastModified() > maxAgeMs && f.delete()) gone++;
        }
        return gone;
    }
}
