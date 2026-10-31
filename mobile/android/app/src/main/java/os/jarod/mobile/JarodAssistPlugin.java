package os.jarod.mobile;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the page whether it runs inside the assistant window (AssistActivity) rather than the app,
 * and closes that window. In the app itself it answers "not hosted" and closing does nothing. Also
 * switches the floating bubble (FloatingOrbService) on and off.
 */
@CapacitorPlugin(name = "JarodAssist")
public class JarodAssistPlugin extends Plugin {

    @PluginMethod
    public void context(PluginCall call) {
        Activity activity = getActivity();
        JSObject out = new JSObject();
        boolean hosted = activity instanceof AssistActivity;
        out.put("hosted", hosted);
        out.put("source", hosted ? ((AssistActivity) activity).source() : "app");
        call.resolve(out);
    }

    @PluginMethod
    public void close(PluginCall call) {
        Activity activity = getActivity();
        if (activity instanceof AssistActivity) activity.runOnUiThread(activity::finish);
        call.resolve();
    }

    /** The bubble: whether the system lets Jarod draw over other apps, and whether it is showing. */
    @PluginMethod
    public void orb(PluginCall call) {
        call.resolve(orbState(allowed(), FloatingOrbService.isRunning()));
    }

    /** Shows the bubble when the system allows it; otherwise `allowed` is false and nothing starts. */
    @PluginMethod
    public void orbStart(PluginCall call) {
        boolean allowed = allowed();
        if (!allowed) {
            call.resolve(orbState(false, false));
            return;
        }
        FloatingOrbService.start(getContext());
        // The service adds its window a moment later, and may fail to: the answer is what it did.
        new Handler(Looper.getMainLooper()).postDelayed(() -> call.resolve(orbState(true, FloatingOrbService.isRunning())), 400);
    }

    @PluginMethod
    public void orbStop(PluginCall call) {
        FloatingOrbService.stop(getContext());
        call.resolve(orbState(allowed(), false));
    }

    private boolean allowed() {
        return Settings.canDrawOverlays(getContext());
    }

    private static JSObject orbState(boolean allowed, boolean running) {
        JSObject out = new JSObject();
        out.put("allowed", allowed);
        out.put("running", running);
        return out;
    }
}
