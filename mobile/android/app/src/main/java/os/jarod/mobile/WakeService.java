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
 * device's wake token, over the Wi-Fi or Tailscale, and learns only a counter: when it moves, the
 * phone shows "Jarod a du nouveau" with no content. The content is fetched by the app, unlocked,
 * over the encrypted channel. No push service (Google or other) is involved.
 */
public class WakeService extends Service {

    static final String PREFS = "jarod.wake";
    private static final String CHANNEL_WATCH = "jarod-watch";
    private static final String CHANNEL_NEWS = "jarod-news";
    private static final int ID_WATCH = 1;
    private static final int ID_NEWS = 2;
    private static final int WAIT_MS = 25_000;

    /** Set by MainActivity: while the app is on screen, it tells the news itself. */
    static volatile boolean appVisible = false;

    private volatile boolean running = false;
    private Thread worker;

    static void start(Context ctx) {
        Intent i = new Intent(ctx, WakeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, WakeService.class));
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
            worker = new Thread(this::loop, "jarod-wake");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void loop() {
        int failures = 0;
        while (running) {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String token = p.getString("token", "");
            String[] urls = p.getString("urls", "").split(",");
            long since = p.getLong("seq", 0);
            if (token.isEmpty()) break;
            boolean reached = false;
            for (String base : urls) {
                if (base.isEmpty() || !running) continue;
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
                    if (o.optBoolean("news", false) && !appVisible) news(p);
                    p.edit().putLong("seq", seq).putString("urls", first(base, urls)).apply();
                    reached = true;
                    failures = 0;
                    break;
                } catch (Exception e) {
                    // Not reachable from here (other network, Tailscale off): try the next address.
                }
            }
            if (!running) break;
            if (!reached) {
                failures++;
                sleep(Math.min(300_000L, 15_000L << Math.min(failures, 5)));
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

    private void news(SharedPreferences p) {
        Notification n = new NotificationCompat.Builder(this, CHANNEL_NEWS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(p.getString("title", "Jarod a du nouveau"))
            .setContentText(p.getString("text", "Ouvrez l’appli pour voir."))
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

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            running = false;
        }
    }
}
