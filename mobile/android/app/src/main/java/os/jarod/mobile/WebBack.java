package os.jarod.mobile;

import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * The back gesture asks the page first: while a sheet, a dialog or a sub-page is open the page
 * closes it (window.__jarodBack, src/lib/back.ts), and only then does the activity leave. Capacitor
 * does not do this by itself. Shared by the app and the assistant window.
 */
final class WebBack {

    private WebBack() {}

    static OnBackPressedCallback install(BridgeActivity activity) {
        OnBackPressedCallback callback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = activity.getBridge() != null ? activity.getBridge().getWebView() : null;
                if (web == null) {
                    leave();
                    return;
                }
                // The page closes its top layer and answers true; anything else (false, no answer,
                // a page not loaded yet) lets the activity leave.
                web.evaluateJavascript("(function(){return typeof window.__jarodBack==='function'&&window.__jarodBack()})()", answer -> {
                    if (!"true".equals(answer)) leave();
                });
            }

            /** Nothing left to close in the page: the system's own back. */
            private void leave() {
                setEnabled(false);
                activity.getOnBackPressedDispatcher().onBackPressed();
            }
        };
        activity.getOnBackPressedDispatcher().addCallback(activity, callback);
        return callback;
    }
}
