// Portage de packages/core/test/eventstore.test.ts:31-89,139-157 (rév. 2e180305).
// Tests « agent turn » (:91-137, :159-172) : portés en Phase 1 avec plugin-agent.
import { describe, expect, it } from "vitest";
import { EventStoreService } from "../src/eventstore.js";
import { makeCore } from "./helpers.js";

describe("EventStoreService", () => {
  it("appends entries and hands out a monotonic seq", async () => {
    const core = await makeCore();
    const first = core.events.append("global", "test-a", { n: 1 });
    const second = core.events.append("global", "test-b", { n: 2 });

    expect(first?.seq).toBeGreaterThan(0);
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    const log = core.events.list({ stream: "global" });
    expect(log.map((e) => e.type)).toEqual(["test-a", "test-b"]);
    // the payload survives the round trip
    expect(log[0]?.data).toEqual({ n: 1 });
  });

  it("filters by stream, type, seq cursor and limit", async () => {
    const core = await makeCore();
    core.events.append("session:a", "delta", { text: "1" });
    const marker = core.events.append("session:a", "delta", { text: "2" });
    core.events.append("session:b", "delta", { text: "3" });
    core.events.append("session:a", "done", {});

    expect(core.events.list({ stream: "session:a" })).toHaveLength(3);
    expect(core.events.list({ type: "done" })).toHaveLength(1);
    expect(core.events.list({ stream: "session:a", after: marker?.seq })).toHaveLength(1);
    expect(core.events.list({ stream: "session:a", limit: 2 })).toHaveLength(2);
  });

  it("summarises the streams it holds", async () => {
    const core = await makeCore();
    core.events.append("session:a", "delta", {});
    core.events.append("session:a", "done", {});
    core.events.append("session:b", "done", {});

    const streams = core.events.streams();
    expect(streams.map((s) => s.stream)).toEqual(["session:b", "session:a"]);
    expect(streams.find((s) => s.stream === "session:a")?.events).toBe(2);
  });

  it("delivers live events to subscribers and stops after unsubscribe", async () => {
    const core = await makeCore();
    const seen: string[] = [];
    const stop = core.events.subscribe((event) => seen.push(event.type));
    core.events.append("global", "kept", {});
    stop();
    core.events.append("global", "lost", {});

    expect(seen).toEqual(["kept"]);
  });

  it("survives a broken log and reports it instead of failing the caller", async () => {
    const core = await makeCore();
    core.db.run("DROP TABLE events");

    expect(() => core.events.append("global", "boom")).not.toThrow();
    // Once the log is known broken, writers stop instead of hammering the database on every event.
    expect(core.events.append("global", "boom")).toBeNull();
    expect(core.events.stats()).toMatchObject({ enabled: false, dropped: 1 });
    expect(core.events.stats().lastError).toMatch(/events/);
  });
  it("a subscriber that throws does not switch the log off", async () => {
    const core = await makeCore();
    core.events.subscribe(() => {
      throw new Error("lecteur cassé");
    });
    core.events.append("global", "first");
    // Before: the listener's error became the log's own, and every later append returned null.
    expect(core.events.append("global", "second")).not.toBeNull();
    expect(core.events.stats()).toMatchObject({ enabled: true, listenerErrors: 2 });
  });

  it("stays bounded while it runs, not only when asked", async () => {
    const core = await makeCore();
    const log = new EventStoreService(core.db, { keep: 5, pruneEvery: 2 });
    for (let i = 0; i < 40; i += 1) log.append("global", "tick", { i });
    expect(log.list({ stream: "global" }).length).toBeLessThanOrEqual(6);
    // The newest survive: trimming takes the oldest first.
    expect(log.list({ stream: "global" }).at(-1)?.data).toEqual({ i: 39 });
  });
});
