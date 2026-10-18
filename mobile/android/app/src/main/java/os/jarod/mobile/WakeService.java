package os.jarod.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The closed app's watch. A foreground service that long-polls the PC's `/m1/wake` with the
 * device's wake token, over the Wi-Fi or Tailscale, and learns only a counter (and how many times it
 * moved, never why): when it moves, the phone shows "Jarod a du nouveau" with no content. The content
 * is fetched by the app, unlocked, over the encrypted channel. No push service (Google or other) is
 * involved. While the phone has no network at all, the watch sleeps until one comes back instead of
 * knocking on every address.
 */
public class WakeService extends Service {

    static final String PREFS = "jarod.wake";
    private static final String CHANNEL_WATCH = "jarod-watch";
    private static final String CHANNEL_NEWS = "jarod-news";
    private static final int ID_WATCH = 1;
    static final int ID_NEWS = 2;
    private static final int WAIT_MS = 25_000;
    private static final long BACKOFF_FIRST_MS = 15_000L;
    private static final long BACKOFF_MAX_MS = 300_000L;

    /** Set by MainActivity: while the app is on screen, it tells the news itself. */
    static volatile boolean appVisible = false;

    private volatile boolean running = false;
    /** Whether the system reports a network that can carry traffic (Wi-Fi, mobile data, a VPN). */
    private volatile boolean online = true;
    private final Object signal = new Object();
    private Thread worker;
    private ConnectivityManager.NetworkCallback netCallback;

    static void start(Context ctx) {
        Intent i = new Intent(ctx, WakeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, WakeService.class));
    }

    /** True when a wake token is stored, i.e. the owner turned the watch on and the PC still knows it. */
    static boolean armed(Context ctx) {
        return !ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString("token", "").isEmpty();
    }

    /** The waiting-news notification goes when the app is opened: it shows the news itself. */
    static void seen(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("unseen", 0).apply();
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ID_NEWS);
    }

    /**
     * How long to wait after `failures` rounds in a row where no address answered: 15 s, then
     * doubling, never more than 5 min. Only counts rounds tried with a network up.
     */
    static long backoff(int failures) {
        if (failures <= 0) return 0;
        return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS << Math.min(failures - 1, 5));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels();
        Notification watch = new NotificationCompat.Builder(this, CHANNEL_WATCH)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Jarod veille")
            .setContentText("Attend des nouvelles de votre PC, sans en lire le contenu.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openApp())
            .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        ServiceCompat.startForeground(this, ID_WATCH, watch, type);
        if (!running) {
            running = true;
            watchNetwork();
            worker = new Thread(this::loop, "jarod-wake");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        unwatchNetwork();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void watchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        online = hasNetwork(cm, cm.getActiveNetwork());
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                online = true;
                wakeUp();
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                boolean now = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                if (now && !online) {
                    online = true;
                    wakeUp();
                } else online = now;
            }

            @Override
            public void onLost(Network network) {
                online = hasNetwork(cm, cm.getActiveNetwork());
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (RuntimeException e) {
            // Too many callbacks registered by the system for this app: poll as before, blindly.
            netCallback = null;
            online = true;
        }
    }

    private void unwatchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null || netCallback == null) return;
        try {
            cm.unregisterNetworkCallback(netCallback);
        } catch (RuntimeException e) {
            // Already gone.
        }
        netCallback = null;
    }

    /**
     * A carrier, not the internet: the PC is on the LAN or the tailnet, so a Wi-Fi without internet
     * access (not "validated") still counts.
     */
    private static boolean hasNetwork(ConnectivityManager cm, Network n) {
        if (n == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void wakeUp() {
        synchronized (signal) {
            signal.notifyAll();
        }
    }

    /** Waits `ms` (0 = until woken), or until a network comes back. False when the service is stopping. */
    private boolean pause(long ms) {
        try {
            synchronized (signal) {
                signal.wait(ms);
            }
            return running;
        } catch (InterruptedException e) {
            running = false;
            return false;
        }
    }

    private void loop() {
        int failures = 0;
        while (running) {
            if (!online) {
                // Nothing to reach: sleep until the system says a network is up (re-checked every
                // 5 min, in case a callback was missed), then try at once, without back-off.
                if (!pause(BACKOFF_MAX_MS)) break;
                if (online) failures = 0;
                continue;
            }
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String token = p.getString("token", "");
            String[] urls = p.getString("urls", "").split(",");
            long since = p.getLong("seq", 0);
            if (token.isEmpty()) break;
            boolean reached = false;
            for (String base : urls) {
                if (base.isEmpty() || !running || !online) continue;
                try {
                    int[] status = new int[1];
                    String body = get(base + "/m1/wake?since=" + since + "&wait=" + WAIT_MS, token, status);
                    if (status[0] == 401) {
                        // Revoked on the PC, or replaced by a newer token: this watch is over.
                        p.edit().clear().apply();
                        running = false;
                        break;
                    }
                    if (status[0] != 200) continue;
                    JSONObject o = new JSONObject(body);
                    long seq = o.optLong("seq", since);
                    if (o.optBoolean("news", false) && !appVisible) news(p, Math.max(1, o.optInt("count", 1)));
                    p.edit().putLong("seq", seq).putString("urls", first(base, urls)).apply();
                    reached = true;
                    failures = 0;
                    break;
                } catch (Exception e) {
                    // Not reachable from here (other network, Tailscale off): try the next address.
                }
            }
            if (!running) break;
            if (!reached && online) {
                failures++;
                if (!pause(backoff(failures))) break;
            }
        }
        stopSelf();
    }

    private static String first(String base, String[] urls) {
        StringBuilder b = new StringBuilder(base);
        for (String u : urls) if (!u.equals(base) && !u.isEmpty()) b.append(',').append(u);
        return b.toString();
    }

    private static String get(String url, String token, int[] status) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5_000);
        c.setReadTimeout(WAIT_MS + 10_000);
        c.setRequestProperty("authorization", "Bearer " + token);
        c.setUseCaches(false);
        try {
            status[0] = c.getResponseCode();
            InputStream in = status[0] < 400 ? c.getInputStream() : c.getErrorStream();
            if (in == null) return "";
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < 4096) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            c.disconnect();
        }
    }

    /**
     * "Jarod a du nouveau", or "N nouvelles" when the counter moved several times. Not shown when the
     * owner turned every kind of notification off on this phone (the wake cannot tell kinds apart).
     */
    private void news(SharedPreferences p, int count) {
        if (!p.getBoolean("notify", true)) return;
        int unseen = Math.min(999, p.getInt("unseen", 0) + count);
        p.edit().putInt("unseen", unseen).apply();
        String title = unseen > 1 ? "Jarod a " + unseen + " nouvelles" : p.getString("title", "Jarod a du nouveau");
        Notification n = new NotificationCompat.Builder(this, CHANNEL_NEWS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(p.getString("text", "Ouvrez l’appli pour voir."))
            .setNumber(unseen)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp())
            .build();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(ID_NEWS, n);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_WATCH, "Veille", NotificationManager.IMPORTANCE_MIN));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_NEWS, "Nouvelles de Jarod", NotificationManager.IMPORTANCE_DEFAULT));
    }
}
