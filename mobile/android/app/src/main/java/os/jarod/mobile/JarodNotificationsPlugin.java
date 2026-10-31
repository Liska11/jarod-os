package os.jarod.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The page's side of the notification reader (JarodNotificationListenerService): whether the owner
 * allowed it, which apps they ticked, and a snapshot of those apps' showing notifications. Nothing
 * is read unless the owner both allowed the access in the system and ticked the app here.
 */
@CapacitorPlugin(name = "JarodNotifications")
public class JarodNotificationsPlugin extends Plugin {

    private static final String PREFS = "jarod.notif";
    private static final String KEY_ALLOWED = "allowed";
    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;

    @PluginMethod
    public void status(PluginCall call) {
        Context c = getContext();
        JSObject out = new JSObject();
        out.put("enabled", NotificationManagerCompat.getEnabledListenerPackages(c).contains(c.getPackageName()));
        out.put("connected", JarodNotificationListenerService.connected() != null);
        JSArray allowed = new JSArray();
        for (String p : allowed(c)) allowed.put(p);
        out.put("allowed", allowed);
        call.resolve(out);
    }

    /** Apps with a notification showing right now, which the owner could tick. */
    @PluginMethod
    public void apps(PluginCall call) {
        Context c = getContext();
        JarodNotificationListenerService live = JarodNotificationListenerService.connected();
        Map<String, String> found = new LinkedHashMap<>();
        if (live != null) {
            for (String pkg : live.packages()) found.put(pkg, label(c, pkg));
        }
        // Ticked apps with nothing showing stay listed, so they can be unticked.
        for (String p : allowed(c)) {
            if (!found.containsKey(p)) found.put(p, label(c, p));
        }
        JSArray list = new JSArray();
        for (Map.Entry<String, String> e : found.entrySet()) {
            JSObject o = new JSObject();
            o.put("pkg", e.getKey());
            o.put("label", e.getValue());
            list.put(o);
        }
        JSObject out = new JSObject();
        out.put("apps", list);
        call.resolve(out);
    }

    @PluginMethod
    public void setAllowed(PluginCall call) {
        Set<String> next = new HashSet<>();
        JSArray packages = call.getArray("packages");
        if (packages != null) {
            for (int i = 0; i < packages.length(); i++) {
                String p = packages.optString(i, "");
                if (!p.isEmpty() && p.length() <= 200) next.add(p);
            }
        }
        prefs(getContext()).edit().putStringSet(KEY_ALLOWED, next).apply();
        call.resolve();
    }

    /** The ticked apps' showing notifications, newest first. Empty when nothing is allowed or connected. */
    @PluginMethod
    public void snapshot(PluginCall call) {
        Context c = getContext();
        int limit = Math.max(1, Math.min(MAX_LIMIT, call.getInt("limit", DEFAULT_LIMIT)));
        Set<String> allowed = allowed(c);
        JarodNotificationListenerService live = JarodNotificationListenerService.connected();
        JSArray items = new JSArray();
        if (live != null && !allowed.isEmpty()) {
            List<JarodNotificationListenerService.Item> list = live.snapshot(allowed, limit);
            for (JarodNotificationListenerService.Item it : list) {
                JSObject o = new JSObject();
                o.put("app", label(c, it.pkg));
                o.put("title", it.title);
                o.put("text", it.text);
                o.put("when", it.whenMs);
                items.put(o);
            }
        }
        JSObject out = new JSObject();
        out.put("items", items);
        call.resolve(out);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static Set<String> allowed(Context c) {
        return new HashSet<>(prefs(c).getStringSet(KEY_ALLOWED, new HashSet<String>()));
    }

    /** The app's name when the system shows it to us, else the end of its package name. */
    private static String label(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return NotificationRules.fallbackLabel(pkg);
        }
    }
}
