package os.jarod.mobile;

import android.content.Intent;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * The system will not list a voice interaction service without a recognition service. Jarod does
 * not recognize speech on the phone: the owner's voice is recorded and the PC transcribes it
 * (src/lib/voice.ts). So this one only answers "not available", and it has no intent filter: it is
 * not offered as a speech engine to other apps.
 */
public class JarodRecognitionService extends RecognitionService {

    @Override
    protected void onStartListening(Intent recognizerIntent, Callback listener) {
        try {
            listener.error(SpeechRecognizer.ERROR_CLIENT);
        } catch (android.os.RemoteException ignored) {
            // The caller is gone: nothing to tell.
        }
    }

    @Override
    protected void onStopListening(Callback listener) {}

    @Override
    protected void onCancel(Callback listener) {}
}
