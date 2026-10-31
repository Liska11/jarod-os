package os.jarod.mobile;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page's side of the screen reader (JarodAccessibilityService). The page asks the owner for their
 * fingerprint before each call (vault.confirm); nothing here runs on its own.
 */
@CapacitorPlugin(name = "JarodAccessibility")
public class JarodAccessibilityPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        Context c = getContext();
        String enabled = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        JSObject out = new JSObject();
        out.put("enabled", ScreenRules.isEnabled(enabled, c.getPackageName(), JarodAccessibilityService.class.getName()));
        out.put("connected", JarodAccessibilityService.connected() != null);
        out.put("screenshot", Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        call.resolve(out);
    }

    /** The visible text of the app behind the assistant. */
    @PluginMethod
    public void screenText(PluginCall call) {
        JarodAccessibilityService svc = JarodAccessibilityService.connected();
        if (svc == null) {
            call.reject("L’accès à l’écran n’est pas activé.");
            return;
        }
        if (!ConfirmGate.consume(SystemClock.elapsedRealtime())) {
            call.reject("Confirmation manquante : l’empreinte est demandée à chaque lecture.");
            return;
        }
        // Walking a big screen's nodes takes a moment: off the thread that serves the page.
        new Thread(() -> {
            String text = svc.screenText();
            if (text == null) {
                call.reject("Aucune autre appli à lire.");
                return;
            }
            JSObject out = new JSObject();
            out.put("text", text);
            call.resolve(out);
        }, "jarod-screen-text").start();
    }

    /** A JPEG of the app behind the assistant, as base64. */
    @PluginMethod
    public void screenshot(PluginCall call) {
        JarodAccessibilityService svc = JarodAccessibilityService.connected();
        if (svc == null) {
            call.reject("L’accès à l’écran n’est pas activé.");
            return;
        }
        if (!ConfirmGate.consume(SystemClock.elapsedRealtime())) {
            call.reject("Confirmation manquante : l’empreinte est demandée à chaque lecture.");
            return;
        }
        svc.screenshot((data, error) -> {
            if (error != null) {
                call.reject(error);
                return;
            }
            JSObject out = new JSObject();
            out.put("mime", "image/jpeg");
            out.put("data", data);
            call.resolve(out);
        });
    }
}
