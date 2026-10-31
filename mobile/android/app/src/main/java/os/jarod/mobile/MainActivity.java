package os.jarod.mobile;

import android.os.Bundle;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** The back gesture asks the page first (WebBack.java). */
    private OnBackPressedCallback webBack;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(JarodWakePlugin.class);
        registerPlugin(JarodLaunchPlugin.class);
        registerPlugin(JarodSpeechPlugin.class);
        registerPlugin(JarodSystemPlugin.class);
        registerPlugin(JarodAssistPlugin.class);
        registerPlugin(JarodNotificationsPlugin.class);
        registerPlugin(JarodAccessibilityPlugin.class);
        super.onCreate(savedInstanceState);
        CaptureCleanup.purgeInBackground(this);
        // Conversations and approvals stay out of screenshots and the recent-apps preview (release
        // builds only: a debug build can be captured, to check the screens).
        if (!BuildConfig.DEBUG) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
        webBack = WebBack.install(this);
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
