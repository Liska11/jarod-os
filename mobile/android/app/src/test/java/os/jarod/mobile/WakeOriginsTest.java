package os.jarod.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The addresses the closed-app watch may dial (and send its token to, in clear): private and tailnet only. */
public class WakeOriginsTest {

    @Test
    public void acceptsPrivateAndTailnetIps() {
        for (String u : new String[] {
            "http://192.168.1.42:10492", "http://10.0.0.4:10492", "http://172.16.0.1:10492", "http://172.31.255.254:10492",
            "http://169.254.3.3:10492", "http://100.64.0.1:10492", "http://100.101.102.103:10492", "http://100.127.255.255:10492",
            "http://127.0.0.1:10492", "http://[fd7a:115c:a1e0::a82e:493e]:10492", "http://[fe80::1]:10492", "http://[::1]:10492",
        }) {
            assertTrue(u, JarodWakePlugin.allowedOrigin(u));
        }
    }

    @Test
    public void acceptsAMagicDnsName() {
        assertTrue(JarodWakePlugin.allowedOrigin("http://hp-z2i.tailb39d55.ts.net:10492"));
        assertTrue(JarodWakePlugin.allowedOrigin("http://hp-z2i.tailb39d55.ts.net"));
    }

    @Test
    public void refusesPublicAddressesAndOtherDomains() {
        for (String u : new String[] {
            "http://8.8.8.8:10492", "http://172.32.0.1:10492", "http://100.63.255.255:10492", "http://100.128.0.1:10492",
            "http://192.169.0.1:10492", "http://256.1.1.1:10492", "http://[2001:db8::1]:10492", "http://example.com:10492",
            "http://jarod.example.org", "http://hp.tailb39d55.ts.net.evil.com:10492", "http://tailb39d55.ts.net:10492",
            "http://ts.net", "http://HP.TAIL.TS.NET:10492", "https://192.168.1.42:10492", "http://user:pw@192.168.1.42:10492",
            "http://192.168.1.42:10492/x", "http://192.168.1.42:999999", "", "javascript:alert(1)",
        }) {
            assertFalse(u, JarodWakePlugin.allowedOrigin(u));
        }
    }
}
