package os.jarod.mobile;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.util.Log;
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

    /** Same language, whether the engine writes it "fr" or "fra" (Samsung's engine uses the latter). */
    private static boolean sameLanguage(Locale a, Locale b) {
        try {
            return a.getISO3Language().equals(b.getISO3Language());
        } catch (Exception e) {
            return a.getLanguage().equals(b.getLanguage());
        }
    }

    /** An installed voice for the language, never one that needs the network; null if there is none. */
    private Voice offlineVoice(Locale locale) {
        java.util.Set<Voice> voices = tts.getVoices();
        if (voices == null) return null;
        Voice best = null;
        for (Voice v : voices) {
            if (debug()) Log.d("JarodSpeech", v.getName() + " " + v.getLocale() + " net=" + v.isNetworkConnectionRequired() + " " + v.getFeatures());
            if (v.isNetworkConnectionRequired()) continue;
            if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            if (!sameLanguage(v.getLocale(), locale)) continue;
            // The country first (fr-FR before fr-CA for a French phone), then the quality.
            if (best == null || rank(v, locale) > rank(best, locale)) best = v;
        }
        return best;
    }

    /**
     * Engines that list no usable Voice object (some vendors') still say whether the language's data
     * is on the phone; KEY_FEATURE_EMBEDDED_SYNTHESIS on each request keeps the synthesis local.
     */
    private boolean installedLanguage(Locale locale) {
        int r = tts.isLanguageAvailable(locale);
        if (debug()) Log.d("JarodSpeech", "isLanguageAvailable(" + locale + ") = " + r);
        return r >= TextToSpeech.LANG_AVAILABLE;
    }

    /** Voice lists go to the log of a debuggable build only. */
    private boolean debug() {
        return (getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
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
        Locale locale = localeOf(call);
        boolean usable = ok && (offlineVoice(locale) != null || installedLanguage(locale));
        out.put("available", usable);
        if (!ok) out.put("reason", "Aucun moteur de synthèse vocale sur ce téléphone.");
        else if (!usable) out.put("reason", "Aucune voix installée sur le téléphone pour cette langue.");
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
        Locale locale = localeOf(call);
        Voice voice = offlineVoice(locale);
        if (voice != null) tts.setVoice(voice);
        else if (installedLanguage(locale)) tts.setLanguage(locale);
        else {
            call.reject("Aucune voix installée sur le téléphone pour cette langue.");
            return;
        }
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
