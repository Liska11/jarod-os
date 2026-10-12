// Passerelle compatible Hermes (essai) : lecture du texte de planification que le shell envoie.
import { describe, expect, it } from "vitest";
import { parseScheduleText, ScheduleTextError } from "../src/gateway/schedule-text.js";

const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime(); // 11 octobre 2026, 12:00 local

describe("parseScheduleText", () => {
  it("intervalles : minutes, heures, jours", () => {
    expect(parseScheduleText("every 30m", NOW)).toEqual({ kind: "interval", minutes: 30 });
    expect(parseScheduleText("every 6h", NOW)).toEqual({ kind: "interval", minutes: 360 });
    expect(parseScheduleText("Every 2 days", NOW)).toEqual({ kind: "interval", minutes: 2880 });
  });

  it("quotidien, jours ouvrés, week-end, jour de semaine", () => {
    expect(parseScheduleText("daily at 7am", NOW)).toEqual({ kind: "daily", time: "07:00" });
    expect(parseScheduleText("daily at 6:30 pm", NOW)).toEqual({ kind: "daily", time: "18:30" });
    expect(parseScheduleText("weekdays at 8:00", NOW)).toEqual({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] });
    expect(parseScheduleText("weekends at 10am", NOW)).toEqual({ kind: "daily", time: "10:00", days: [0, 6] });
    expect(parseScheduleText("every monday 9am", NOW)).toEqual({ kind: "daily", time: "09:00", days: [1] });
    expect(parseScheduleText("every friday at 18:05", NOW)).toEqual({ kind: "daily", time: "18:05", days: [5] });
  });

  it("minuit et midi", () => {
    expect(parseScheduleText("daily at 12am", NOW)).toMatchObject({ time: "00:00" });
    expect(parseScheduleText("daily at 12pm", NOW)).toMatchObject({ time: "12:00" });
  });

  it("expression cron et horodatage local", () => {
    expect(parseScheduleText("0 9 * * 1-5", NOW)).toEqual({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(parseScheduleText("2026-12-24T14:30", NOW)).toEqual({ kind: "once", at: new Date(2026, 11, 24, 14, 30, 0).getTime() });
  });

  it("refuse ce qu'il ne comprend pas, avec un message qui dit les formats, sans valeur par défaut", () => {
    for (const bad of ["", "   ", "whenever", "every 0x", "every banana", "daily at 25:00", "daily at 13pm", "every someday 9am", "1 2 3 4", "2026-02-31T10:00", "2026-01-01T10:00"]) {
      expect(() => parseScheduleText(bad, NOW), bad).toThrow(ScheduleTextError);
    }
    expect(() => parseScheduleText("whenever", NOW)).toThrow(/every 30m/);
    expect(() => parseScheduleText("2026-01-01T10:00", NOW)).toThrow(/past/);
  });
});
