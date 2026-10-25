// File de messages et pilotage : la logique pure, sans réseau ni noyau.
import { describe, expect, it } from "vitest";
import { MAX_PROMPT_CHARS, MAX_QUEUED, MAX_STEERING, PromptQueue, PromptQueueError } from "../src/gateway/prompt-queue.js";

describe("file de messages", () => {
  it("garde l'ordre d'arrivée, par conversation", () => {
    const q = new PromptQueue();
    q.add("a", "un");
    q.add("a", "deux");
    q.add("b", "autre");
    expect(q.list("a").map((i) => i.text)).toEqual(["un", "deux"]);
    expect(q.next("a")?.text).toBe("un");
    expect(q.next("a")?.text).toBe("deux");
    expect(q.next("a")).toBeUndefined();
    expect(q.list("b")).toHaveLength(1);
  });

  it("retire un message précis ou vide toute la file", () => {
    const q = new PromptQueue();
    const first = q.add("a", "un");
    q.add("a", "deux");
    expect(q.remove("a", first.id)).toBe(true);
    expect(q.remove("a", first.id)).toBe(false);
    expect(q.list("a").map((i) => i.text)).toEqual(["deux"]);
    expect(q.clear("a")).toBe(1);
    expect(q.list("a")).toEqual([]);
  });

  it("refuse un message vide, trop long, ou une file pleine — avec une erreur nette", () => {
    const q = new PromptQueue();
    expect(() => q.add("a", "   ")).toThrow(PromptQueueError);
    expect(() => q.add("a", "x".repeat(MAX_PROMPT_CHARS + 1))).toThrow(/trop long/);
    for (let i = 0; i < MAX_QUEUED; i++) q.add("a", `m${i}`);
    expect(() => q.add("a", "de trop")).toThrow(/pleine/);
    expect(() => q.add("b", "autre conversation")).not.toThrow();
  });

  it("remet en tête un message dont le départ a échoué, avec son identifiant", () => {
    const q = new PromptQueue();
    q.add("a", "deux");
    const item = { id: "x", text: "un", at: 1 };
    q.pushFront("a", item);
    expect(q.next("a")).toEqual(item);
  });
});

describe("pilotage", () => {
  it("la boîte se lit sans retirer (peek), puis se vide (take)", () => {
    const q = new PromptQueue();
    const inbox = q.steering("a");
    expect(inbox.peek()).toBe(false);
    expect(q.steer("a", "change de piste")).toBe(1);
    expect(q.steer("a", "et vite")).toBe(2);
    expect(inbox.peek()).toBe(true);
    expect(inbox.take()).toEqual(["change de piste", "et vite"]);
    expect(inbox.peek()).toBe(false);
    expect(inbox.take()).toEqual([]);
  });

  it("borne le nombre de consignes en attente", () => {
    const q = new PromptQueue();
    for (let i = 0; i < MAX_STEERING; i++) q.steer("a", `c${i}`);
    expect(() => q.steer("a", "de trop")).toThrow(/trop de messages de pilotage/);
  });

  it("les consignes non lues passent EN TÊTE de la file, dans l'ordre où elles ont été écrites", () => {
    const q = new PromptQueue();
    q.add("a", "plus tard");
    q.steer("a", "première consigne");
    q.steer("a", "seconde consigne");
    expect(q.demoteSteering("a")).toBe(2);
    expect(q.list("a").map((i) => i.text)).toEqual(["première consigne", "seconde consigne", "plus tard"]);
    expect(q.demoteSteering("a")).toBe(0);
  });

  it("oublier une conversation efface sa file et ses consignes", () => {
    const q = new PromptQueue();
    q.add("a", "x");
    q.steer("a", "y");
    q.forget("a");
    expect(q.list("a")).toEqual([]);
    expect(q.steering("a").peek()).toBe(false);
  });
});
