// Portage de packages/core/src/services/notifications.ts (rév. 2e180305).
import type { Db } from "./db.js";
import type { Notification } from "@jarod/contracts";
import { Emitter, newId, now } from "@jarod/kernel/util";

interface Row {
  id: string;
  kind: Notification["kind"];
  title: string;
  body: string;
  read: number;
  created_at: number;
}

const toNotification = (r: Row): Notification => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  read: r.read === 1,
  createdAt: r.created_at,
});

/** In-app notification feed (skill update receipts, plugin errors, workflow results…). */
export class NotificationService extends Emitter<{ added: Notification }> {
  constructor(private readonly db: Db) {
    super();
  }

  add(kind: Notification["kind"], title: string, body = ""): Notification {
    const id = newId();
    this.db.run(
      "INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      kind,
      title,
      body,
      now(),
    );
    const n = toNotification(this.db.get<Row>("SELECT * FROM notifications WHERE id = ?", id)!);
    this.emit("added", n);
    return n;
  }

  list(limit = 100): Notification[] {
    return this.db.all<Row>("SELECT * FROM notifications ORDER BY seq DESC LIMIT ?", limit).map(toNotification);
  }

  markAllRead(): void {
    this.db.run("UPDATE notifications SET read = 1 WHERE read = 0");
  }

  /** Garde les `keep` plus récentes : le fil informe, il n'archive pas. */
  prune(keep = 500): number {
    return this.db.run(
      "DELETE FROM notifications WHERE seq NOT IN (SELECT seq FROM notifications ORDER BY seq DESC LIMIT ?)",
      keep,
    ).changes;
  }

  clear(): void {
    this.db.run("DELETE FROM notifications");
  }
}
