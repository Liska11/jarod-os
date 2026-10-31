package os.jarod.mobile;

import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/** Hands the system a session each time the assistant is called. */
public class JarodVoiceInteractionSessionService extends VoiceInteractionSessionService {
    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        return new JarodVoiceInteractionSession(this);
    }
}
