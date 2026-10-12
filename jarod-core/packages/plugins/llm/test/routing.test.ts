// Portage de packages/core/test/routing.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { RoutingService } from "../src/routing.js";

const a = { provider: "one", model: "gros" };
const b = { provider: "two", model: "moyen" };
const c = { provider: "three", model: "petit" };

function setup() {
  const clock = { value: 1_000 };
  const routing = new RoutingService({ now: () => clock.value, failureThreshold: 3, cooldownMs: 60_000 });
  return { routing, clock };
}

describe("repli et disjoncteur", () => {
  it("rend la chaîne telle quelle tant que tout va bien", () => {
    const { routing } = setup();
    expect(routing.order([a, b, c])).toEqual([a, b, c]);
    // Regarder un candidat le matérialise : ce qui compte est qu'aucun ne soit en échec.
    expect(routing.state().every((s) => s.failures === 0 && s.downUntil === 0)).toBe(true);
  });

  it("écarte un candidat après trois échecs, et le renvoie en fin de chaîne", () => {
    const { routing } = setup();
    routing.record(a, { ok: false });
    routing.record(a, { ok: false });
    expect(routing.order([a, b])).toEqual([a, b]);
    routing.record(a, { ok: false });
    expect(routing.isDown(a)).toBe(true);
    // Toujours dans la liste, mais derrière : un disjoncteur qui refuse de parler est une panne de plus.
    expect(routing.order([a, b])).toEqual([b, a]);
  });

  it("un succès efface les échecs : la santé se regagne", () => {
    const { routing } = setup();
    routing.record(a, { ok: false });
    routing.record(a, { ok: false });
    routing.record(a, { ok: true });
    routing.record(a, { ok: false });
    routing.record(a, { ok: false });
    expect(routing.isDown(a)).toBe(false);
    routing.record(a, { ok: false });
    expect(routing.isDown(a)).toBe(true);
  });

  it("au bout du délai, il repart à neuf — sinon un seul échec le renverrait au tapis", () => {
    const { routing, clock } = setup();
    for (let i = 0; i < 3; i += 1) routing.record(a, { ok: false });
    expect(routing.isDown(a)).toBe(true);
    clock.value += 60_001;
    expect(routing.isDown(a)).toBe(false);
    expect(routing.state().find((s) => s.key === "one:gros")?.failures).toBe(0);
  });

  it("classe par latence MESURÉE, et laisse devant ce qui n'a jamais été mesuré", () => {
    const { routing } = setup();
    routing.record(a, { ok: true, ms: 900 });
    routing.record(b, { ok: true, ms: 120 });
    // c n'a jamais été essayé : il passe devant, sinon un modèle neuf ne serait jamais essayé.
    expect(routing.order([a, b, c], "fastest")).toEqual([c, b, a]);
  });

  it("classe par coût déclaré quand on le demande", () => {
    const { routing } = setup();
    const chain = [
      { ...a, cost: 9 },
      { ...b, cost: 1 },
      { ...c, cost: 4 },
    ];
    expect(routing.order(chain, "cheapest").map((x) => x.cost)).toEqual([1, 4, 9]);
  });

  it("quand TOUT est écarté, la chaîne reste utilisable", () => {
    const { routing } = setup();
    for (const candidate of [a, b, c]) for (let i = 0; i < 3; i += 1) routing.record(candidate, { ok: false });
    // On essaie quand même : refuser de parler serait une panne de plus.
    expect(routing.order([a, b, c])).toHaveLength(3);
  });

  it("garde dans la chaîne un candidat dont le délai expire PENDANT la décision", () => {
    // Horloge qui avance de 30 s à chaque lecture : la première passe le voit encore écarté, la
    // seconde le verrait rétabli. Deux appels à `isDown` décidaient donc sur deux états, et le
    // candidat ne sortait ni dans les disponibles ni dans les écartés : la chaîne le perdait.
    const clock = { value: 0 };
    const routing = new RoutingService({ now: () => (clock.value += 30_000), failureThreshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i += 1) routing.record(a, { ok: false });
    expect(routing.order([a, b])).toEqual([b, a]);
  });

  it("n'essaie qu'une fois un candidat dont le délai vient d'expirer", () => {
    const { routing, clock } = setup();
    for (let i = 0; i < 3; i += 1) routing.record(a, { ok: false });
    clock.value += 60_001;
    expect(routing.order([b, a]).filter((candidate) => candidate === a)).toHaveLength(1);
  });
});
