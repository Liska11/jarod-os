// Un démarrage refusé se dit en une ligne, avec un code de sortie distinct : la fenêtre n'affiche que ces
// messages (pas de pile Node brute). Cas réels : profil déjà servi, port fixe occupé.
import { RuntimeLockError } from "@jarod/plugin-agent";
import { describe, expect, it } from "vitest";
import { MAX_STARTUP_MESSAGE, startupFailure } from "../src/gateway/startup.js";

describe("startupFailure", () => {
  it("reprend tel quel le message du verrou de profil (il dit déjà quoi faire)", () => {
    const failure = startupFailure(new RuntimeLockError({ pid: 10852, mode: "desktop", startedAt: Date.now() }));
    expect(failure.code).toBe(3);
    expect(failure.message).toContain("déjà servi par un autre processus (application de bureau, pid 10852)");
    expect(failure.message).toContain("jarod headless stop");
    expect(failure.message).not.toContain("Démarrage impossible"); // pas de double emballage
  });

  it("nomme le port occupé et la sortie de secours quand l'écoute échoue", () => {
    const e = new Error("listen EADDRINUSE: address already in use 127.0.0.1:52425") as NodeJS.ErrnoException;
    e.code = "EADDRINUSE";
    Object.assign(e, { port: 52425 });
    const failure = startupFailure(e);
    expect(failure.code).toBe(3);
    expect(failure.message).toContain("52425");
    expect(failure.message).toContain("JAROD_GATEWAY_PORT");
    expect(failure.message).not.toContain("EADDRINUSE"); // ni code technique ni pile dans la fenêtre
  });

  it("emballe tout autre échec sans perdre sa cause", () => {
    expect(startupFailure(new Error("base illisible"))).toEqual({ code: 3, message: "Démarrage impossible : base illisible" });
    expect(startupFailure("disque plein")).toEqual({ code: 3, message: "Démarrage impossible : disque plein" });
    expect(startupFailure(undefined).code).toBe(3);
  });

  it("masque un secret recraché par un échec inattendu, et garde la ligne courte", () => {
    const failure = startupFailure(new Error(`clé refusée: sk-${"a".repeat(32)} ${"x".repeat(400)}`));
    expect(failure.message).not.toContain("sk-aaaa");
    expect(failure.message).toContain("sk-[masqué]");
    expect(failure.message.length).toBeLessThanOrEqual(MAX_STARTUP_MESSAGE);
  });

  it("masque un jeton passé en query dans une URL citée par l'erreur", () => {
    const failure = startupFailure(new Error("GET http://127.0.0.1:9/api/memory?token=abcdef0123456789ABCDEF -> 500"));
    expect(failure.message).not.toContain("abcdef0123456789ABCDEF");
    expect(failure.message).toContain("token=[masqué]");
  });
});
