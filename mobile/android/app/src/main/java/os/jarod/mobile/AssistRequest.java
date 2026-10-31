package os.jarod.mobile;

/**
 * Which door the assistant was opened from. Only the action decides: nothing else in the intent is
 * read, so another app cannot put words in the owner's mouth through it.
 */
final class AssistRequest {

    static final String ACTION_ASSIST = "android.intent.action.ASSIST";
    static final String ACTION_VOICE_ASSIST = "android.intent.action.VOICE_ASSIST";
    /** Only sent by our own bubble (FloatingOrbService), to an explicit component. */
    static final String ACTION_ORB = "os.jarod.mobile.action.ORB";

    private AssistRequest() {}

    /** "assist" (the system's assistant gesture), "voice" (the voice-assist key), "orb" (the bubble), "app" (anything else). */
    static String sourceOf(String action) {
        if (ACTION_ASSIST.equals(action)) return "assist";
        if (ACTION_VOICE_ASSIST.equals(action)) return "voice";
        if (ACTION_ORB.equals(action)) return "orb";
        return "app";
    }
}
