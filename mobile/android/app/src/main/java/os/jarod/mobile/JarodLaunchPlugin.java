package os.jarod.mobile;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The `jarod://pair#…` link that opened the app (the phone's camera read the PC's QR code), handed
 * to the pairing screen. The app still checks it like a pasted link.
 */
@CapacitorPlugin(name = "JarodLaunch")
public class JarodLaunchPlugin extends Plugin {

    private String pending = "";

    @Override
    public void load() {
        take(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (take(intent)) {
            JSObject out = new JSObject();
            out.put("link", pending);
            notifyListeners("link", out, true);
        }
    }

    private boolean take(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        if (data == null || !"jarod".equals(data.getScheme()) || !"pair".equals(data.getHost())) return false;
        pending = data.toString();
        intent.setData(null);
        return true;
    }

    /** The link, once: read it and it is gone. */
    @PluginMethod
    public void take(PluginCall call) {
        JSObject out = new JSObject();
        out.put("link", pending);
        pending = "";
        call.resolve(out);
    }
}
