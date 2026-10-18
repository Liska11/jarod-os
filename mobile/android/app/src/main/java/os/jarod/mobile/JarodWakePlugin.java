package os.jarod.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts and stops the closed-app watch (`WakeService`). The wake token is content-free by design.
 * Once started, the watch also comes back by itself after a restart of the phone (`BootReceiver`).
 */
@CapacitorPlugin(name = "JarodWake")
public class JarodWakePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token", "");
        JSArray urls = call.getArray("urls", new JSArray());
        if (token.isEmpty() || urls.length() == 0) {
            call.reject("jeton ou adresses manquants");
            return;
        }
        StringBuilder joined = new StringBuilder();
        try {
            for (int i = 0; i < urls.length(); i++) {
                String u = urls.getString(i);
                // Plain origins only, as the pairing link gave them.
                if (!u.matches("^http://[0-9a-fA-F.:\\[\\]]+(:\\d+)?$")) continue;
                if (joined.length() > 0) joined.append(',');
                joined.append(u);
            }
        } catch (Exception e) {
            call.reject("adresses illisibles");
            return;
        }
        Context ctx = getContext();
        SharedPreferences.Editor p = ctx.getSharedPreferences(WakeService.PREFS, Context.MODE_PRIVATE).edit();
        p.putString("token", token)
            .putString("urls", joined.toString())
            .putLong("seq", call.getLong("seq", 0L))
            .putString("title", call.getString("title", "Jarod a du nouveau"))
            .putString("text", call.getString("text", "Ouvrez l’appli pour voir."))
            .putBoolean("notify", call.getBoolean("notify", true))
            .apply();
        WakeService.stop(ctx);
        WakeService.start(ctx);
        call.resolve();
    }

    /**
     * Whether the closed-app notification is shown at all. The wake carries no kind, so the phone's
     * per-kind choices can only say "nothing" (every kind off) or "something".
     */
    @PluginMethod
    public void configure(PluginCall call) {
        getContext().getSharedPreferences(WakeService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean("notify", call.getBoolean("notify", true))
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.getSharedPreferences(WakeService.PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        WakeService.stop(ctx);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        String token = getContext().getSharedPreferences(WakeService.PREFS, Context.MODE_PRIVATE).getString("token", "");
        JSObject out = new JSObject();
        out.put("running", !token.isEmpty());
        call.resolve(out);
    }
}
