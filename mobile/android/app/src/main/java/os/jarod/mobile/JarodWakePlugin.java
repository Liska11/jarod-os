package os.jarod.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Starts and stops the closed-app watch (`WakeService`). The wake token is content-free by design.
 * Once started, the watch also comes back by itself after a restart of the phone (`BootReceiver`).
 */
@CapacitorPlugin(name = "JarodWake")
public class JarodWakePlugin extends Plugin {

    private static final Pattern V4 = Pattern.compile("^http://(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})(:\\d{1,5})?$");
    private static final Pattern V6 = Pattern.compile("^http://\\[([0-9a-fA-F:]+)\\](:\\d{1,5})?$");
    /** machine.tailnet.ts.net, lower case: at least a machine and a tailnet before ".ts.net". */
    private static final Pattern NAME =
        Pattern.compile("^http://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\\.ts\\.net(:\\d{1,5})?$");

    /**
     * Whether the watch may dial this origin, and send its token there in clear: a private or tailnet IP
     * (the same ranges the PC's bridge accepts), or a MagicDNS name. The page checks the same rules
     * before calling; this is the second lock, for the one place the token travels.
     */
    static boolean allowedOrigin(String u) {
        if (u.length() > 200) return false;
        if (NAME.matcher(u).matches()) return true;
        Matcher m = V4.matcher(u);
        if (m.matches()) {
            int a = Integer.parseInt(m.group(1));
            int b = Integer.parseInt(m.group(2));
            if (a > 255 || b > 255 || Integer.parseInt(m.group(3)) > 255 || Integer.parseInt(m.group(4)) > 255) return false;
            return a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127);
        }
        m = V6.matcher(u);
        if (m.matches()) {
            String h = m.group(1).toLowerCase(java.util.Locale.ROOT);
            // ::1, unique local (fc00::/7, Tailscale's fd7a:… included), link-local (fe80::/10).
            return h.equals("::1") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb");
        }
        return false;
    }

    private static String joinOrigins(JSArray urls) throws Exception {
        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < urls.length() && i < 8; i++) {
            String u = urls.getString(i);
            if (!allowedOrigin(u)) continue;
            if (joined.length() > 0) joined.append(',');
            joined.append(u);
        }
        return joined.toString();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token", "");
        JSArray urls = call.getArray("urls", new JSArray());
        if (token.isEmpty() || urls.length() == 0) {
            call.reject("jeton ou adresses manquants");
            return;
        }
        String joined;
        try {
            joined = joinOrigins(urls);
        } catch (Exception e) {
            call.reject("adresses illisibles");
            return;
        }
        Context ctx = getContext();
        SharedPreferences.Editor p = ctx.getSharedPreferences(WakeService.PREFS, Context.MODE_PRIVATE).edit();
        p.putString("token", token)
            .putString("urls", joined)
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
     * The PC's addresses changed (it sent its current list): the watch uses them from its next round,
     * without restarting and without touching its token. Nothing happens while the watch is off.
     */
    @PluginMethod
    public void setUrls(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(WakeService.PREFS, Context.MODE_PRIVATE);
        if (p.getString("token", "").isEmpty()) {
            call.resolve();
            return;
        }
        try {
            String joined = joinOrigins(call.getArray("urls", new JSArray()));
            if (!joined.isEmpty()) p.edit().putString("urls", joined).apply();
        } catch (Exception e) {
            call.reject("adresses illisibles");
            return;
        }
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
