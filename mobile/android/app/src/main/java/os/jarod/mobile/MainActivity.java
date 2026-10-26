package os.jarod.mobile;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The back gesture asks the page first: while a sheet, a dialog or a sub-page is open the page
     * closes it (window.__jarodBack, src/lib/back.ts), and only then does the app leave. Capacitor
     * does not do this by itself.
     */
    private OnBackPressedCallback webBack;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(JarodWakePlugin.class);
        registerPlugin(JarodLaunchPlugin.class);
        registerPlugin(JarodSpeechPlugin.class);
        registerPlugin(JarodSystemPlugin.class);
        super.onCreate(savedInstanceState);
        // Conversations and approvals stay out of screenshots and the recent-apps preview (release
        // builds only: a debug build can be captured, to check the screens).
        if (!BuildConfig.DEBUG) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
        webBack = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) {
                    leave();
                    return;
                }
                // The page closes its top layer and answers true; anything else (false, no answer,
                // a page not loaded yet) lets the app leave.
                web.evaluateJavascript("(function(){return typeof window.__jarodBack==='function'&&window.__jarodBack()})()", answer -> {
                    if (!"true".equals(answer)) leave();
                });
            }

            /** Nothing left to close in the page: the system's own back (leave the app). */
            private void leave() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, webBack);
    }

    @Override
    public void onResume() {
        super.onResume();
        // The app may have stayed alive after a "leave": the history handler is needed again.
        if (webBack != null) webBack.setEnabled(true);
        WakeService.appVisible = true;
        WakeService.seen(this);
    }

    @Override
    public void onPause() {
        WakeService.appVisible = false;
        super.onPause();
    }
}
