package os.jarod.mobile;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * The assistant over whatever the owner was doing: a translucent window with its own WebView that
 * shows the page's assistant sheet (src/screens/AssistScreen.tsx). The PC channel and the device key
 * live only in a page, so this window unlocks with the fingerprint like the app does, then talks to
 * the PC itself. It registers only the plugins the sheet needs: no wake watch, no pairing link.
 */
public class AssistActivity extends BridgeActivity {

    private String source = "app";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(JarodSpeechPlugin.class);
        registerPlugin(JarodSystemPlugin.class);
        registerPlugin(JarodAssistPlugin.class);
        registerPlugin(JarodNotificationsPlugin.class);
        registerPlugin(JarodAccessibilityPlugin.class);
        super.onCreate(savedInstanceState);
        CaptureCleanup.purgeInBackground(this);
        // BridgeActivity sets its own theme: translucency is asked for again, so the app below shows through.
        setTheme(R.style.AppTheme_Assist);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        if (!BuildConfig.DEBUG) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
        source = AssistRequest.sourceOf(getIntent() != null ? getIntent().getAction() : null);
        // The page closes its top layer (a sheet, a dialog) before back closes the window.
        WebBack.install(this);
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        // singleTask: a later call (the bubble, then the gesture) lands here, with its own door.
        setIntent(intent);
        source = AssistRequest.sourceOf(intent != null ? intent.getAction() : null);
    }

    @Override
    public void onStart() {
        super.onStart();
        FloatingOrbService.assistOpen(true);
        // The page paints its own sheet; the rest of the WebView must not hide the app behind it.
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
        }
    }

    @Override
    public void onStop() {
        FloatingOrbService.assistOpen(false);
        super.onStop();
    }

    String source() {
        return source;
    }
}
