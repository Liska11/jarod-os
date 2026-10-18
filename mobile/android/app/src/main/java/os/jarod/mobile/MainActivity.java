package os.jarod.mobile;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(JarodWakePlugin.class);
        registerPlugin(JarodLaunchPlugin.class);
        registerPlugin(JarodSpeechPlugin.class);
        super.onCreate(savedInstanceState);
        // Conversations and approvals stay out of screenshots and the recent-apps preview.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    public void onResume() {
        super.onResume();
        WakeService.appVisible = true;
    }

    @Override
    public void onPause() {
        WakeService.appVisible = false;
        super.onPause();
    }
}
