// What a notification is about, for the phone's per-kind choices (docs/ANDROID-APP.md §5).
import { describe, expect, it } from "vitest";
import { notificationTopic } from "../src/remote-host.js";

describe("notificationTopic", () => {
  it("sorts what the core writes into tasks, reminders, alerts and the rest", () => {
    expect(notificationTopic({ kind: "success", title: "Tâche planifiée « Rapport »" })).toBe("task");
    expect(notificationTopic({ kind: "success", title: "Déclencheur « git-push »" })).toBe("task");
    expect(notificationTopic({ kind: "success", title: "Tâche planifiée « Rappel : dentiste »" })).toBe("reminder");
    expect(notificationTopic({ kind: "info", title: "Rappel de test" })).toBe("reminder");
    expect(notificationTopic({ kind: "warning", title: "Mise à jour disponible" })).toBe("alert");
    expect(notificationTopic({ kind: "info", title: "Nouvelle skill apprise : x" })).toBe("other");
  });

  it("a failure is an alert, even a reminder's", () => {
    expect(notificationTopic({ kind: "error", title: "Tâche planifiée « Rappel : dentiste »" })).toBe("alert");
    expect(notificationTopic({ kind: "error", title: "Plugin x en erreur" })).toBe("alert");
  });
});
