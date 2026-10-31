package os.jarod.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class NotificationRulesTest {

    private static final String OWN = "os.jarod.mobile";
    private final Set<String> allowed = new HashSet<>(Collections.singletonList("com.whatsapp"));

    @Test
    public void anAllowedAppIsIncluded() {
        assertTrue(NotificationRules.include("com.whatsapp", OWN, false, false, false, allowed));
    }

    @Test
    public void anAppThatWasNotTickedIsLeftOut() {
        assertFalse(NotificationRules.include("com.bank", OWN, false, false, false, allowed));
        assertFalse(NotificationRules.include("com.bank", OWN, false, false, false, Collections.<String>emptySet()));
    }

    @Test
    public void nullMeansAnyAppForTheListOfChoices() {
        assertTrue(NotificationRules.include("com.bank", OWN, false, false, false, null));
    }

    @Test
    public void ourOwnNotificationsAreNeverRead() {
        assertFalse(NotificationRules.include(OWN, OWN, false, false, false, null));
        assertFalse(NotificationRules.include(OWN, OWN, false, false, false, new HashSet<>(Collections.singletonList(OWN))));
    }

    @Test
    public void ongoingSummaryAndSecretOnesAreSkippedEvenWhenAllowed() {
        assertFalse(NotificationRules.include("com.whatsapp", OWN, true, false, false, allowed));
        assertFalse(NotificationRules.include("com.whatsapp", OWN, false, true, false, allowed));
        assertFalse(NotificationRules.include("com.whatsapp", OWN, false, false, true, allowed));
        assertFalse(NotificationRules.include(null, OWN, false, false, false, null));
    }

    @Test
    public void clipCollapsesSpacesAndCuts() {
        assertEquals("a b c", NotificationRules.clip("  a \n b\t c ", 10));
        assertEquals("abcd…", NotificationRules.clip("abcdefgh", 5));
        assertEquals("", NotificationRules.clip(null, 5));
    }

    @Test
    public void fallbackLabelIsTheLastSegment() {
        assertEquals("messaging", NotificationRules.fallbackLabel("com.google.android.apps.messaging"));
        assertEquals("solo", NotificationRules.fallbackLabel("solo"));
        assertEquals("", NotificationRules.fallbackLabel(null));
    }
}
