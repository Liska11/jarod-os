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
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * The round Jarod bubble over every app: drag it to a side, tap it to open the assistant
 * (AssistActivity). It shows no content and sends nothing: a tap only opens the same sheet the
 * system's assistant gesture does. A foreground service, so the system keeps it; its notification
 * has a "Stop" action and says nothing about the owner's conversations.
 */
public class FloatingOrbService extends Service {

    static final String ACTION_STOP = "os.jarod.mobile.action.STOP_ORB";
    private static final String CHANNEL = "jarod-orb";
    private static final int ID = 3;
    private static final String PREFS = "jarod.orb";
    private static final int SIZE_DP = 56;

    /** Process-wide: the service lives and dies with the app's process. */
    private static volatile boolean running = false;

    /** The assistant window is open: the bubble steps aside instead of covering its buttons. */
    private static volatile boolean assistOpen = false;
    private static volatile FloatingOrbService current;

    private WindowManager windows;
    private OrbView orb;
    private WindowManager.LayoutParams params;

    static boolean isRunning() {
        return running;
    }

    /** Called by AssistActivity as it appears and goes: the bubble hides while the sheet is up. */
    static void assistOpen(boolean open) {
        assistOpen = open;
        FloatingOrbService svc = current;
        if (svc != null && svc.orb != null) svc.orb.post(() -> svc.orb.setVisibility(open ? View.GONE : View.VISIBLE));
    }

    static void start(Context ctx) {
        Intent i = new Intent(ctx, FloatingOrbService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, FloatingOrbService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A foreground service must call startForeground after startForegroundService, even to stop at once.
        channel();
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Bulle Jarod active")
            .setContentText("Touchez la bulle pour ouvrir l’assistant.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .addAction(0, "Arrêter", stopIntent())
            .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        ServiceCompat.startForeground(this, ID, n, type);
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (orb == null && !show()) {
            // The owner took the permission back: no window can be drawn.
            stopSelf();
            return START_NOT_STICKY;
        }
        current = this;
        running = true;
        // Not sticky: after a kill the bubble waits for the owner to switch it on again.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (current == this) current = null;
        if (orb != null && windows != null) {
            try {
                windows.removeView(orb);
            } catch (IllegalArgumentException ignored) {
                // Already gone.
            }
        }
        orb = null;
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Rotated: the sides moved, so the bubble is put back against one.
        if (orb != null) rest(params.x, params.y);
    }

    private boolean show() {
        if (!Settings.canDrawOverlays(this)) return false;
        windows = (WindowManager) getSystemService(WINDOW_SERVICE);
        int size = px(SIZE_DP);
        DisplayMetrics m = getResources().getDisplayMetrics();
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        params = new WindowManager.LayoutParams(
            size,
            size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        int[] at = OrbGeometry.settle(p.getInt("x", m.widthPixels), p.getInt("y", m.heightPixels / 3), size, m.widthPixels, m.heightPixels, margin(), margin());
        params.x = at[0];
        params.y = at[1];
        orb = new OrbView(this);
        orb.setVisibility(assistOpen ? View.GONE : View.VISIBLE);
        try {
            windows.addView(orb, params);
        } catch (RuntimeException e) {
            orb = null;
            return false;
        }
        return true;
    }

    /** Puts the bubble against the nearer side and remembers where. */
    private void rest(int x, int y) {
        DisplayMetrics m = getResources().getDisplayMetrics();
        int[] at = OrbGeometry.settle(x, y, params.width, m.widthPixels, m.heightPixels, margin(), margin());
        params.x = at[0];
        params.y = at[1];
        windows.updateViewLayout(orb, params);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("x", at[0]).putInt("y", at[1]).apply();
    }

    private void openAssistant() {
        Intent i = new Intent(AssistRequest.ACTION_ORB).setClass(this, AssistActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
    }

    private int px(int dp) {
        return Math.round(dp * getResources().getDisplayMetrics().density);
    }

    private int margin() {
        return px(48);
    }

    private PendingIntent stopIntent() {
        Intent i = new Intent(this, FloatingOrbService.class).setAction(ACTION_STOP);
        return PendingIntent.getService(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void channel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Bulle flottante", NotificationManager.IMPORTANCE_MIN));
    }

    /** The bubble: a glowing blue sphere, drawn by hand (no resource to load in an overlay). */
    private final class OrbView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
        private float downX;
        private float downY;
        private int startX;
        private int startY;
        private boolean dragged;

        OrbView(Context c) {
            super(c);
            setContentDescription("Ouvrir l’assistant Jarod");
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float r = Math.min(getWidth(), getHeight()) / 2f;
            paint.setShader(new RadialGradient(r * 0.8f, r * 0.7f, r, new int[] {Color.rgb(140, 190, 255), Color.rgb(47, 125, 255), Color.rgb(16, 40, 110)}, new float[] {0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
            canvas.drawCircle(r, r, r - 2, paint);
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = params.x;
                    startY = params.y;
                    dragged = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    // Once the finger has left the slop circle it is a drag for good, even if it comes back.
                    if (dragged || !OrbGeometry.isTap(e.getRawX() - downX, e.getRawY() - downY, slop)) {
                        dragged = true;
                        params.x = startX + Math.round(e.getRawX() - downX);
                        params.y = startY + Math.round(e.getRawY() - downY);
                        windows.updateViewLayout(this, params);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!dragged) {
                        performClick();
                        openAssistant();
                    } else {
                        rest(params.x, params.y);
                    }
                    return true;
                default:
                    return super.onTouchEvent(e);
            }
        }

        @Override
        public boolean performClick() {
            return super.performClick();
        }
    }
}
