package os.jarod.mobile;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads Jarod's replies aloud with the phone's own speech engine. Only voices installed on the phone
 * are used (no network synthesis): if the language has none, nothing is said and `status` says why.
 * The WebView has no `speechSynthesis`, hence this plugin.
 */
@CapacitorPlugin(name = "JarodSpeech")
public class JarodSpeechPlugin extends Plugin {

    private TextToSpeech tts;
    /** null while the engine starts, then whether it did. */
    private Boolean ready = null;
    private final List<PluginCall> waiting = new ArrayList<>();
    private int utterance = 0;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            ready = status == TextToSpeech.SUCCESS;
            List<PluginCall> calls;
            synchronized (waiting) {
                calls = new ArrayList<>(waiting);
                waiting.clear();
            }
            for (PluginCall call : calls) run(call);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.handleOnDestroy();
    }

    /** Runs the call once the engine has started. */
    private void whenReady(PluginCall call) {
        synchronized (waiting) {
            if (ready == null) {
                waiting.add(call);
                return;
            }
        }
        run(call);
    }

    private void run(PluginCall call) {
        if ("speak".equals(call.getMethodName())) doSpeak(call);
        else doStatus(call);
    }

    /** An installed voice for the language, never one that needs the network; null if there is none. */
    private Voice offlineVoice(Locale locale) {
        if (tts.getVoices() == null) return null;
        Voice best = null;
        for (Voice v : tts.getVoices()) {
            if (v.isNetworkConnectionRequired()) continue;
            if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            if (!v.getLocale().getLanguage().equals(locale.getLanguage())) continue;
            // The country first (fr-FR before fr-CA for a French phone), then the quality.
            if (best == null || rank(v, locale) > rank(best, locale)) best = v;
        }
        return best;
    }

    private static int rank(Voice v, Locale locale) {
        return (v.getLocale().getCountry().equals(locale.getCountry()) ? 1000 : 0) + v.getQuality();
    }

    private static Locale localeOf(PluginCall call) {
        String tag = call.getString("lang", "");
        return tag == null || tag.isEmpty() ? Locale.getDefault() : Locale.forLanguageTag(tag);
    }

    @PluginMethod
    public void status(PluginCall call) {
        whenReady(call);
    }

    private void doStatus(PluginCall call) {
        JSObject out = new JSObject();
        boolean ok = Boolean.TRUE.equals(ready);
        Voice voice = ok ? offlineVoice(localeOf(call)) : null;
        out.put("available", ok && voice != null);
        if (!ok) out.put("reason", "Aucun moteur de synthèse vocale sur ce téléphone.");
        else if (voice == null) out.put("reason", "Aucune voix installée sur le téléphone pour cette langue.");
        call.resolve(out);
    }

    /** `text`: one piece of a reply; `flush`: true for the first piece (stops what was being said). */
    @PluginMethod
    public void speak(PluginCall call) {
        whenReady(call);
    }

    private void doSpeak(PluginCall call) {
        if (!Boolean.TRUE.equals(ready)) {
            call.reject("Aucun moteur de synthèse vocale sur ce téléphone.");
            return;
        }
        Voice voice = offlineVoice(localeOf(call));
        if (voice == null) {
            call.reject("Aucune voix installée sur le téléphone pour cette langue.");
            return;
        }
        tts.setVoice(voice);
        Bundle params = new Bundle();
        params.putString(TextToSpeech.Engine.KEY_FEATURE_EMBEDDED_SYNTHESIS, "true");
        int mode = Boolean.TRUE.equals(call.getBoolean("flush", false)) ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
        int r = tts.speak(call.getString("text", ""), mode, params, "jarod-" + (++utterance));
        if (r == TextToSpeech.SUCCESS) call.resolve();
        else call.reject("La synthèse vocale a échoué.");
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }
}
