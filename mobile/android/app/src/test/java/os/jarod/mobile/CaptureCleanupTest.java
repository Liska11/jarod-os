package os.jarod.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

public class CaptureCleanupTest {

    private static final long HOUR = 60L * 60 * 1000;
    private static final long NOW = 1_000_000_000_000L;

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File shot(String name, long ageMs) throws IOException {
        File f = tmp.newFile(name);
        assertTrue(f.setLastModified(NOW - ageMs));
        return f;
    }

    @Test
    public void oldCameraShotsAreDeletedAndRecentOnesKept() throws IOException {
        File old = shot("JPEG_20261030_101500_123.jpg", 7 * HOUR);
        File fresh = shot("JPEG_20261031_101500_456.jpg", HOUR);
        assertEquals(1, CaptureCleanup.purge(tmp.getRoot(), NOW, CaptureCleanup.MAX_AGE_MS));
        assertFalse(old.exists());
        assertTrue(fresh.exists());
    }

    @Test
    public void nothingButCapacitorsOwnNamesIsTouched() throws IOException {
        File other = shot("notes.txt", 100 * HOUR);
        File otherJpeg = shot("holiday.jpg", 100 * HOUR);
        assertEquals(0, CaptureCleanup.purge(tmp.getRoot(), NOW, CaptureCleanup.MAX_AGE_MS));
        assertTrue(other.exists());
        assertTrue(otherJpeg.exists());
    }

    @Test
    public void aMissingFolderIsNotAnError() {
        assertEquals(0, CaptureCleanup.purge(null, NOW, CaptureCleanup.MAX_AGE_MS));
        assertEquals(0, CaptureCleanup.purge(new File(tmp.getRoot(), "absent"), NOW, CaptureCleanup.MAX_AGE_MS));
    }

    /** The FileProvider must only ever point at the camera folder, never at a whole storage root. */
    @Test
    public void fileProviderPathsStayInsideThePicturesFolder() throws Exception {
        File xml = new File("src/main/res/xml/file_paths.xml");
        assertTrue("run from android/app: " + xml.getAbsolutePath(), xml.isFile());
        NodeList paths = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml).getDocumentElement().getChildNodes();
        int seen = 0;
        for (int i = 0; i < paths.getLength(); i++) {
            if (!(paths.item(i) instanceof Element)) continue;
            Element e = (Element) paths.item(i);
            seen++;
            assertEquals("external-files-path", e.getTagName());
            assertEquals("Pictures/", e.getAttribute("path"));
        }
        assertEquals(1, seen);
    }
}
