package os.jarod.mobile;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The device key's safe. An AES-256-GCM key in the Android Keystore (StrongBox when the phone has
 * one) that can be used only right after a fingerprint, a face or the phone's PIN, once per use, and
 * that dies if a new fingerprint is enrolled. It wraps the phone's X25519 key: the app stores only
 * the wrapped blob, and the clear key exists only in memory while the app is unlocked.
 */
@CapacitorPlugin(name = "DeviceVault")
public class DeviceVaultPlugin extends Plugin {

    private static final String ALIAS = "jarod-device-key-wrap";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private interface OnPass {
        void run(BiometricPrompt.AuthenticationResult result) throws Exception;
    }

    @PluginMethod
    public void status(PluginCall call) {
        int can = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject out = new JSObject();
        out.put("available", can == BiometricManager.BIOMETRIC_SUCCESS);
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            out.put("reason", can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ? "none-enrolled" : "unavailable");
        }
        call.resolve(out);
    }

    @PluginMethod
    public void seal(PluginCall call) {
        String plaintext = call.getString("plaintext");
        if (plaintext == null) {
            call.reject("plaintext manquant");
            return;
        }
        try {
            // A new pairing gets a new wrapping key: nothing from a previous one survives.
            deleteKey();
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, createKey());
            prompt(call, cipher, result -> {
                Cipher c = result.getCryptoObject().getCipher();
                byte[] sealed = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
                JSObject out = new JSObject();
                out.put("blob", "v1." + b64(c.getIV()) + "." + b64(sealed));
                call.resolve(out);
            });
        } catch (Exception e) {
            call.reject("Clé impossible à créer : " + e.getMessage());
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String blob = call.getString("blob", "");
        String[] parts = blob.split("\\.");
        if (parts.length != 3 || !"v1".equals(parts[0])) {
            call.reject("Clé enregistrée illisible");
            return;
        }
        try {
            SecretKey key = loadKey();
            if (key == null) {
                call.reject("KeyPermanentlyInvalidated: clé absente");
                return;
            }
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, unb64(parts[1])));
            byte[] sealed = unb64(parts[2]);
            prompt(call, cipher, result -> {
                byte[] clear = result.getCryptoObject().getCipher().doFinal(sealed);
                JSObject out = new JSObject();
                out.put("plaintext", new String(clear, StandardCharsets.UTF_8));
                call.resolve(out);
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("KeyPermanentlyInvalidated: " + e.getMessage());
        } catch (Exception e) {
            call.reject("Déverrouillage impossible : " + e.getMessage());
        }
    }

    /** A fresh proof of presence for one decision (accepting an action). Cancelled = not approved. */
    @PluginMethod
    public void confirm(PluginCall call) {
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    JSObject out = new JSObject();
                    out.put("ok", true);
                    call.resolve(out);
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence message) {
                    JSObject out = new JSObject();
                    out.put("ok", false);
                    call.resolve(out);
                }
            });
            bp.authenticate(info(call));
        });
    }

    @PluginMethod
    public void wipe(PluginCall call) {
        try {
            deleteKey();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private void prompt(PluginCall call, Cipher cipher, OnPass onPass) {
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        onPass.run(result);
                    } catch (Exception e) {
                        call.reject("Opération refusée par le Keystore : " + e.getMessage());
                    }
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence message) {
                    call.reject(message.toString(), String.valueOf(code));
                }
            });
            bp.authenticate(info(call), new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private BiometricPrompt.PromptInfo info(PluginCall call) {
        BiometricPrompt.PromptInfo.Builder b = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(call.getString("title", "Jarod"))
            .setAllowedAuthenticators(AUTHENTICATORS);
        String subtitle = call.getString("subtitle");
        if (subtitle != null && !subtitle.isEmpty()) b.setSubtitle(subtitle);
        return b.build();
    }

    private SecretKey createKey() throws Exception {
        try {
            return generate(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);
        } catch (StrongBoxUnavailableException e) {
            return generate(false);
        }
    }

    private SecretKey generate(boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // 0 = one authentication per use: an unlocked phone left on a table opens nothing.
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setInvalidatedByBiometricEnrollment(true);
        if (strongBox) spec.setIsStrongBoxBacked(true);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(spec.build());
        return gen.generateKey();
    }

    private SecretKey loadKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return (SecretKey) ks.getKey(ALIAS, null);
    }

    private void deleteKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
    }

    private static String b64(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
    }

    private static byte[] unb64(String text) {
        return Base64.decode(text, Base64.URL_SAFE | Base64.NO_PADDING);
    }
}
