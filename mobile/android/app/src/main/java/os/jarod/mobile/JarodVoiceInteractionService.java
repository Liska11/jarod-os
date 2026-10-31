package os.jarod.mobile;

import android.service.voice.VoiceInteractionService;

/**
 * What makes Jarod a choice under Settings → Default apps → Digital assistant. It does nothing
 * itself: the system starts a session (JarodVoiceInteractionSession) when the owner calls the
 * assistant, and that session opens AssistActivity.
 */
public class JarodVoiceInteractionService extends VoiceInteractionService {}
