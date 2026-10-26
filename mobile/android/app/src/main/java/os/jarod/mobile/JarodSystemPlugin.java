package os.jarod.mobile;

import android.Manifest;
import android.app.usage.UsageStatsManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.graphics.Color;
import android.provider.Settings;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * What the page may know about the phone's system: the wallpaper's colours (Android 12+, Material
 * You), the battery state an app is allowed to read, and shortcuts into the system settings. Nothing
 * here touches the channel, the key or the voice.
 */
@CapacitorPlugin(
    name = "JarodSystem",
    permissions = {@Permission(alias = "nearby", strings = {Manifest.permission.NEARBY_WIFI_DEVICES})}
)
public class JarodSystemPlugin extends Plugin {

    /**
     * The local network permission. Android 16 can restrict an app's access to the local network until
     * "Nearby devices" (NEARBY_WIFI_DEVICES) is granted. Below Android 13 the permission does not exist:
     * "unneeded". Jarod uses no location and scans no device: it only dials its own PC's address.
     */
    private String nearbyState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "unneeded";
        PermissionState s = getPermissionState("nearby");
        if (s == PermissionState.GRANTED) return "granted";
        return s == PermissionState.DENIED ? "denied" : "prompt";
    }

    @PluginMethod
    public void localNetwork(PluginCall call) {
        JSObject out = new JSObject();
        out.put("state", nearbyState());
        call.resolve(out);
    }

    /** The system's own dialog; the answer is the state afterwards (a permanent refusal answers at once). */
    @PluginMethod
    public void requestLocalNetwork(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("nearby") == PermissionState.GRANTED) {
            localNetwork(call);
            return;
        }
        requestPermissionForAlias("nearby", call, "localNetworkDone");
    }

    @PermissionCallback
    private void localNetworkDone(PluginCall call) {
        localNetwork(call);
    }

    /** Colours: the system's own tonal palette, mapped to Material 3 roles for both schemes. */
    @PluginMethod
    public void colors(PluginCall call) {
        JSObject out = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            out.put("supported", false);
            out.put("light", new JSObject());
            out.put("dark", new JSObject());
            call.resolve(out);
            return;
        }
        try {
            Context c = getContext();
            JSObject light = new JSObject();
            light.put("primary", hex(c, android.R.color.system_accent1_600));
            light.put("onPrimary", hex(c, android.R.color.system_accent1_0));
            light.put("primaryContainer", hex(c, android.R.color.system_accent1_100));
            light.put("onPrimaryContainer", hex(c, android.R.color.system_accent1_900));
            light.put("secondaryContainer", hex(c, android.R.color.system_accent2_100));
            light.put("onSecondaryContainer", hex(c, android.R.color.system_accent2_900));
            light.put("surface", hex(c, android.R.color.system_neutral1_10));
            light.put("surfaceLow", hex(c, android.R.color.system_neutral1_50));
            light.put("surfaceContainer", mix(c, android.R.color.system_neutral1_50, android.R.color.system_neutral1_100, 0.5f));
            light.put("surfaceHigh", hex(c, android.R.color.system_neutral1_100));
            light.put("surfaceHighest", mix(c, android.R.color.system_neutral1_100, android.R.color.system_neutral1_200, 0.4f));
            light.put("onSurface", hex(c, android.R.color.system_neutral1_900));
            light.put("onSurfaceVariant", hex(c, android.R.color.system_neutral2_700));
            light.put("outline", hex(c, android.R.color.system_neutral2_500));
            light.put("outlineVariant", hex(c, android.R.color.system_neutral2_200));
            JSObject dark = new JSObject();
            dark.put("primary", hex(c, android.R.color.system_accent1_200));
            dark.put("onPrimary", hex(c, android.R.color.system_accent1_800));
            dark.put("primaryContainer", hex(c, android.R.color.system_accent1_700));
            dark.put("onPrimaryContainer", hex(c, android.R.color.system_accent1_100));
            dark.put("secondaryContainer", hex(c, android.R.color.system_accent2_700));
            dark.put("onSecondaryContainer", hex(c, android.R.color.system_accent2_100));
            dark.put("surface", mixBlack(c, android.R.color.system_neutral1_900, 0.4f));
            dark.put("surfaceLow", hex(c, android.R.color.system_neutral1_900));
            dark.put("surfaceContainer", mix(c, android.R.color.system_neutral1_900, android.R.color.system_neutral1_800, 0.25f));
            dark.put("surfaceHigh", mix(c, android.R.color.system_neutral1_900, android.R.color.system_neutral1_800, 0.6f));
            dark.put("surfaceHighest", hex(c, android.R.color.system_neutral1_800));
            dark.put("onSurface", hex(c, android.R.color.system_neutral1_100));
            dark.put("onSurfaceVariant", hex(c, android.R.color.system_neutral2_200));
            dark.put("outline", hex(c, android.R.color.system_neutral2_400));
            dark.put("outlineVariant", hex(c, android.R.color.system_neutral2_700));
            out.put("supported", true);
            out.put("light", light);
            out.put("dark", dark);
        } catch (RuntimeException e) {
            out.put("supported", false);
            out.put("light", new JSObject());
            out.put("dark", new JSObject());
        }
        call.resolve(out);
    }

    /** A colour between two of the system's tones: the palette has fewer steps than Material 3's surfaces. */
    private static String mix(Context c, int a, int b, float t) {
        int x = c.getColor(a);
        int y = c.getColor(b);
        int r = Math.round(((x >> 16) & 0xFF) * (1 - t) + ((y >> 16) & 0xFF) * t);
        int g = Math.round(((x >> 8) & 0xFF) * (1 - t) + ((y >> 8) & 0xFF) * t);
        int bl = Math.round((x & 0xFF) * (1 - t) + (y & 0xFF) * t);
        return String.format("#%02X%02X%02X", r, g, bl);
    }

    /** A tone darkened towards black by `t`. */
    private static String mixBlack(Context c, int a, float t) {
        int x = c.getColor(a);
        return String.format("#%02X%02X%02X", Math.round(((x >> 16) & 0xFF) * (1 - t)), Math.round(((x >> 8) & 0xFF) * (1 - t)), Math.round((x & 0xFF) * (1 - t)));
    }

    private static String hex(Context c, int res) {
        return String.format("#%06X", 0xFFFFFF & c.getColor(res));
    }

    /**
     * The system bars follow the app's own scheme, not the phone's: dark icons on a light app, light
     * icons on a dark one. Before Android 15 (where the bars are drawn by the app) their colour is the
     * app's too, so they blend with the page; from 15 they are transparent and the page shows through.
     */
    @PluginMethod
    public void setBars(PluginCall call) {
        final boolean dark = !"light".equals(call.getString("scheme", "dark"));
        final String status = call.getString("status", "");
        final String nav = call.getString("nav", "");
        getActivity().runOnUiThread(() -> {
            try {
                Window w = getActivity().getWindow();
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(w, w.getDecorView());
                bars.setAppearanceLightStatusBars(!dark);
                bars.setAppearanceLightNavigationBars(!dark);
                if (Build.VERSION.SDK_INT < 35) {
                    if (status.matches("#[0-9a-fA-F]{6}")) w.setStatusBarColor(Color.parseColor(status));
                    if (nav.matches("#[0-9a-fA-F]{6}")) w.setNavigationBarColor(Color.parseColor(nav));
                }
            } catch (RuntimeException e) {
                // Cosmetic only: the bars keep the system's look.
            }
            call.resolve();
        });
    }

    /** Battery: the optimisation exemption, the power saver and (Android 9+) the standby bucket. */
    @PluginMethod
    public void power(PluginCall call) {
        Context c = getContext();
        JSObject out = new JSObject();
        PowerManager pm = c.getSystemService(PowerManager.class);
        out.put("ignoringBatteryOptimizations", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        out.put("powerSave", pm != null && pm.isPowerSaveMode());
        out.put("manufacturer", Build.MANUFACTURER);
        out.put("model", Build.MODEL);
        out.put("sdk", Build.VERSION.SDK_INT);
        try {
            UsageStatsManager usm = c.getSystemService(UsageStatsManager.class);
            if (usm != null) out.put("standbyBucket", usm.getAppStandbyBucket());
        } catch (RuntimeException e) {
            // Not readable on this build: the page shows "unknown".
        }
        call.resolve(out);
    }

    /**
     * Opens a screen of the system settings. The OnePlus/Oppo auto-start screen has no public intent:
     * the known ones are tried in turn, then the app's own page.
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String target = call.getString("target", "app");
        Context c = getContext();
        Intent i;
        String via = target;
        switch (target) {
            case "battery-optimization":
                i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                break;
            case "battery":
                i = new Intent(Intent.ACTION_POWER_USAGE_SUMMARY);
                break;
            case "battery-saver":
                i = new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS);
                break;
            case "notifications":
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
                break;
            case "autostart":
                // Tried one by one: Android 11+ hides other apps' components from resolveActivity.
                for (String[] k : AUTOSTART) {
                    if (launch(c, new Intent().setComponent(new ComponentName(k[0], k[1])))) {
                        call.resolve(result(true, "autostart"));
                        return;
                    }
                }
                i = appDetails(c);
                via = "app";
                break;
            default:
                i = appDetails(c);
                via = "app";
        }
        if (launch(c, i)) {
            call.resolve(result(true, via));
            return;
        }
        // The first choice is not on this phone: the app's own page always exists.
        call.resolve(result(launch(c, appDetails(c)), "app"));
    }

    private static JSObject result(boolean opened, String via) {
        JSObject o = new JSObject();
        o.put("opened", opened);
        o.put("via", via);
        return o;
    }

    private static Intent appDetails(Context c) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", c.getPackageName(), null));
    }

    private static final String[][] AUTOSTART = {
        {"com.oplus.battery", "com.oplus.startupapp.StartupAppListActivity"},
        {"com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"},
        {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
        {"com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"},
        {"com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerConsumptionActivity"}
    };

    private static boolean launch(Context c, Intent i) {
        try {
            c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
