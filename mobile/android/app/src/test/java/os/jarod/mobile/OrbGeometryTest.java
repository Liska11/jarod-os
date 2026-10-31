package os.jarod.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OrbGeometryTest {

    @Test
    public void aShortMoveIsATap() {
        assertTrue(OrbGeometry.isTap(3, 4, 5));
        assertFalse(OrbGeometry.isTap(4, 4, 5));
    }

    @Test
    public void droppedOnTheLeftHalfItSticksToTheLeftEdge() {
        assertArrayEquals(new int[] {0, 500}, OrbGeometry.settle(100, 500, 150, 1080, 2400, 100, 150));
    }

    @Test
    public void droppedOnTheRightHalfItSticksToTheRightEdge() {
        assertArrayEquals(new int[] {930, 500}, OrbGeometry.settle(700, 500, 150, 1080, 2400, 100, 150));
    }

    @Test
    public void itStaysBetweenTheTopAndBottomMargins() {
        assertEquals(100, OrbGeometry.settle(0, -300, 150, 1080, 2400, 100, 150)[1]);
        assertEquals(2400 - 150 - 150, OrbGeometry.settle(0, 5000, 150, 1080, 2400, 100, 150)[1]);
    }

    @Test
    public void aScreenSmallerThanTheBubbleDoesNotCrash() {
        assertArrayEquals(new int[] {0, 10}, OrbGeometry.settle(0, 0, 150, 100, 100, 10, 10));
    }
}
