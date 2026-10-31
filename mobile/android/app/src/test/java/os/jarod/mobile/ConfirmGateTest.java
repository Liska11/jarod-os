package os.jarod.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ConfirmGateTest {

    @Test
    public void aProofWorksOnceWithinTheWindow() {
        ConfirmGate.grant(1000);
        assertTrue(ConfirmGate.consume(1000 + ConfirmGate.WINDOW_MS));
        assertFalse(ConfirmGate.consume(1001));
    }

    @Test
    public void anOldProofIsRefusedAndConsumed() {
        ConfirmGate.grant(1000);
        assertFalse(ConfirmGate.consume(1000 + ConfirmGate.WINDOW_MS + 1));
        assertFalse(ConfirmGate.consume(1001));
    }

    @Test
    public void nothingGrantedMeansNothingAllowed() {
        ConfirmGate.grant(5);
        ConfirmGate.consume(5);
        assertFalse(ConfirmGate.consume(6));
    }
}
