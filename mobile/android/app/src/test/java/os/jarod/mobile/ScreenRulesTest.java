package os.jarod.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class ScreenRulesTest {

    @Test
    public void joinDropsEmptyAndRepeatedPieces() {
        assertEquals("Panier\n2 articles\nPayer", ScreenRules.join(Arrays.asList("Panier", " ", null, "2  articles", "2 articles", "Payer"), 100));
        assertEquals("", ScreenRules.join(Collections.<String>emptyList(), 100));
    }

    @Test
    public void joinCutsWithAnEllipsis() {
        String out = ScreenRules.join(Arrays.asList("abcdefghij", "klmnopqrst"), 8);
        assertEquals(8, out.length());
        assertTrue(out.endsWith("…"));
    }

    @Test
    public void aNonConsecutiveRepeatIsKept() {
        assertEquals("a\nb\na", ScreenRules.join(Arrays.asList("a", "b", "a"), 100));
    }

    @Test
    public void ourServiceIsFoundInTheSystemsList() {
        String full = "com.other/com.other.Svc:os.jarod.mobile/os.jarod.mobile.JarodAccessibilityService";
        String shortForm = "os.jarod.mobile/.JarodAccessibilityService";
        assertTrue(ScreenRules.isEnabled(full, "os.jarod.mobile", "os.jarod.mobile.JarodAccessibilityService"));
        assertTrue(ScreenRules.isEnabled(shortForm, "os.jarod.mobile", "os.jarod.mobile.JarodAccessibilityService"));
    }

    @Test
    public void anotherAppOrAnEmptyListIsNotUs() {
        String cls = "os.jarod.mobile.JarodAccessibilityService";
        assertFalse(ScreenRules.isEnabled(null, "os.jarod.mobile", cls));
        assertFalse(ScreenRules.isEnabled("", "os.jarod.mobile", cls));
        assertFalse(ScreenRules.isEnabled("os.jarod.mobile.dev/os.jarod.mobile.JarodAccessibilityService", "os.jarod.mobile", cls));
    }

    @Test
    public void aCaptureIsScaledDownButNeverUp() {
        assertArrayEquals(new int[] {739, 1600}, ScreenRules.fit(1080, 2338, 1600));
        assertArrayEquals(new int[] {800, 600}, ScreenRules.fit(800, 600, 1600));
        assertArrayEquals(new int[] {1, 1600}, ScreenRules.fit(1, 100000, 1600));
    }
}
