package os.jarod.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Puts the closed-app watch back after the phone restarts (or the app is updated), but only when a
 * wake token is stored: a phone whose watch was turned off, or that was never paired, starts nothing.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        // Not LOCKED_BOOT_COMPLETED: the wake token lives in credential-protected storage, readable
        // only once the owner has unlocked the phone after the restart.
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        if (!WakeService.armed(ctx)) return;
        try {
            WakeService.start(ctx);
        } catch (RuntimeException e) {
            // The system refused a foreground start right now: the app restarts the watch when opened.
        }
    }
}
