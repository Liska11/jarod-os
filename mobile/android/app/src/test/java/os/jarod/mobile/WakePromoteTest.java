package os.jarod.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The address that answered goes first; a list the page replaced meanwhile is never overwritten with an old one. */
public class WakePromoteTest {

    @Test
    public void movesTheAnsweringAddressToTheFront() {
        assertEquals("http://b:1,http://a:1,http://c:1", WakeService.promote("http://b:1", "http://a:1,http://b:1,http://c:1"));
        assertEquals("http://a:1,http://b:1", WakeService.promote("http://a:1", "http://a:1,http://b:1"));
    }

    @Test
    public void keepsTheNewListWhenTheAnsweringAddressIsNoLongerInIt() {
        // The PC's addresses changed while the poll was waiting: its old IP must not come back.
        assertEquals("http://192.168.1.99:1,http://100.88.1.9:1", WakeService.promote("http://192.168.1.42:1", "http://192.168.1.99:1,http://100.88.1.9:1"));
    }

    @Test
    public void copesWithAnEmptyList() {
        assertEquals("", WakeService.promote("http://a:1", ""));
    }
}
