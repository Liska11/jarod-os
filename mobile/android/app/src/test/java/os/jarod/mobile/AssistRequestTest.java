package os.jarod.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AssistRequestTest {

    @Test
    public void theAssistantGestureIsAssist() {
        assertEquals("assist", AssistRequest.sourceOf("android.intent.action.ASSIST"));
    }

    @Test
    public void theVoiceAssistKeyIsVoice() {
        assertEquals("voice", AssistRequest.sourceOf("android.intent.action.VOICE_ASSIST"));
    }

    @Test
    public void theBubbleIsOrb() {
        assertEquals("orb", AssistRequest.sourceOf("os.jarod.mobile.action.ORB"));
    }

    @Test
    public void anythingElseIsTheApp() {
        assertEquals("app", AssistRequest.sourceOf(null));
        assertEquals("app", AssistRequest.sourceOf(""));
        assertEquals("app", AssistRequest.sourceOf("android.intent.action.VIEW"));
        // Case matters: an action is an exact string.
        assertEquals("app", AssistRequest.sourceOf("android.intent.action.assist"));
    }
}
