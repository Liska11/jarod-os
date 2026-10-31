package os.jarod.mobile;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;

/**
 * One call of the assistant. The system gives a session a window of its own; Jarod draws nothing
 * there and opens its assistant sheet (AssistActivity) instead. The screen's content (onHandleAssist)
 * and screenshot are deliberately not read: the PC is never sent what is on the phone's screen.
 */
public class JarodVoiceInteractionSession extends VoiceInteractionSession {

    JarodVoiceInteractionSession(Context context) {
        super(context);
    }

    @Override
    public void onPrepareShow(Bundle args, int showFlags) {
        super.onPrepareShow(args, showFlags);
        setUiEnabled(false);
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        startAssistantActivity(new Intent(AssistRequest.ACTION_ASSIST).setClass(getContext(), AssistActivity.class));
    }
}
