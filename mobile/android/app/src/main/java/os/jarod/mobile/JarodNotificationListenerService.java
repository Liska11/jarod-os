package os.jarod.mobile;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Lets Jarod read the notifications that are showing, on request only. It stores nothing, logs
 * nothing and does not react when one arrives: JarodNotificationsPlugin asks for a snapshot when the
 * owner taps "Mes notifications" in the chat, and the owner reads and edits the text before sending it.
 * The owner turns this on in the system's own list (Settings → Notification access).
 */
public class JarodNotificationListenerService extends NotificationListenerService {

    /** One notification, reduced to what the owner would read off the screen. */
    static final class Item {
        final String pkg;
        final String title;
        final String text;
        final long whenMs;

        Item(String pkg, String title, String text, long whenMs) {
            this.pkg = pkg;
            this.title = title;
            this.text = text;
            this.whenMs = whenMs;
        }
    }

    private static volatile JarodNotificationListenerService live;

    /** The connected service, or null while the system has not bound it (or access was withdrawn). */
    static JarodNotificationListenerService connected() {
        return live;
    }

    @Override
    public void onListenerConnected() {
        live = this;
    }

    @Override
    public void onListenerDisconnected() {
        if (live == this) live = null;
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        super.onDestroy();
    }

    /** The apps that have a listable notification showing, with no title or text read at all. */
    Set<String> packages() {
        Set<String> out = new LinkedHashSet<>();
        StatusBarNotification[] active;
        try {
            active = getActiveNotifications();
        } catch (RuntimeException e) {
            return out;
        }
        if (active == null) return out;
        for (StatusBarNotification sbn : active) {
            Notification n = sbn.getNotification();
            if (n == null) continue;
            boolean ongoing = (n.flags & Notification.FLAG_ONGOING_EVENT) != 0;
            boolean summary = (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0;
            boolean secret = n.visibility == Notification.VISIBILITY_SECRET;
            if (NotificationRules.include(sbn.getPackageName(), getPackageName(), ongoing, summary, secret, null)) out.add(sbn.getPackageName());
        }
        return out;
    }

    /** The showing notifications of `allowed` apps (null: any app), newest first, at most `limit`. */
    List<Item> snapshot(Set<String> allowed, int limit) {
        StatusBarNotification[] active;
        try {
            active = getActiveNotifications();
        } catch (RuntimeException e) {
            return Collections.emptyList();
        }
        List<Item> out = new ArrayList<>();
        if (active == null) return out;
        for (StatusBarNotification sbn : active) {
            Notification n = sbn.getNotification();
            if (n == null) continue;
            boolean ongoing = (n.flags & Notification.FLAG_ONGOING_EVENT) != 0;
            boolean summary = (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0;
            boolean secret = n.visibility == Notification.VISIBILITY_SECRET;
            if (!NotificationRules.include(sbn.getPackageName(), getPackageName(), ongoing, summary, secret, allowed)) continue;
            Bundle x = n.extras;
            CharSequence text = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (text == null) text = x.getCharSequence(Notification.EXTRA_TEXT);
            out.add(new Item(sbn.getPackageName(), NotificationRules.clip(x.getCharSequence(Notification.EXTRA_TITLE), 120), NotificationRules.clip(text, NotificationRules.MAX_TEXT), sbn.getPostTime()));
        }
        Collections.sort(out, (a, b) -> Long.compare(b.whenMs, a.whenMs));
        return out.size() > limit ? new ArrayList<>(out.subList(0, limit)) : out;
    }
}
