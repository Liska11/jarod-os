/**
 * §3.6-1 de l'audit — la création exclusive (`wx`) ne suffisait pas : entre le `rmSync` d'un verrou
 * périmé et l'écriture, un second démarrage pouvait supprimer notre fichier et poser le sien, et le
 * premier se croyait seul. Le verrou se relit donc après écriture, `startedAt` compris : deux noyaux
 * peuvent porter le même pid (Windows recycle les identifiants), jamais le même instant.
 *
 * Le « second démarrage » est simulé en interceptant l'écriture exclusive (`node:fs` est mocké pour
 * ce fichier seulement) : c'est le seul moyen de se placer EXACTEMENT dans la fenêtre de la course,
 * un test à base de fils concurrents ne serait pas déterministe.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireRuntimeLock, RUNTIME_LOCK_FILE, RuntimeLockError, readRuntimeLock } from "../src/runtime-lock.js";
import { tempDir } from "./helpers.js";

const steal = vi.hoisted(() => ({ armed: false, path: "", content: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]): unknown => {
      const result = (actual.writeFileSync as (...a: unknown[]) => unknown)(...args);
      const options = args[2] as { flag?: string } | undefined;
      // Après la création exclusive, le « second processus » supprime notre fichier et pose le sien.
      if (steal.armed && options?.flag === "wx") actual.writeFileSync(steal.path, steal.content);
      return result;
    },
  };
});

/** Un pid que le système ne peut pas avoir : le détenteur du verrou est mort. */
const DEAD_PID = 2_147_483_000;

afterEach(() => {
  steal.armed = false;
});

describe("§3.6-1 — le verrou de profil ne se prend pas à deux", () => {
  it("une course perdue lève RuntimeLockError au lieu de laisser deux processus se croire seuls", () => {
    const dir = tempDir();
    const path = join(dir, RUNTIME_LOCK_FILE);
    // Un verrou périmé : le détenteur est mort, la reprise est donc légitime et immédiate.
    fs.writeFileSync(path, JSON.stringify({ pid: DEAD_PID, mode: "serve", startedAt: 1 }));

    const thief = { pid: process.ppid, mode: "headless", startedAt: Date.now() + 1 };
    steal.path = path;
    steal.content = JSON.stringify(thief);
    steal.armed = true;

    let thrown: unknown;
    try {
      acquireRuntimeLock(dir, "desktop");
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "la course perdue ne doit pas se solder par un verrou pris").toBeInstanceOf(RuntimeLockError);
    expect((thrown as RuntimeLockError).holder).toMatchObject({ pid: process.ppid, mode: "headless" });
    // Le fichier appartient bien au voleur : on ne l'a pas écrasé en partant.
    expect(readRuntimeLock(dir)?.pid).toBe(process.ppid);
  });

  it("le verrou périmé d'un processus mort est toujours repris", () => {
    const dir = tempDir();
    fs.writeFileSync(join(dir, RUNTIME_LOCK_FILE), JSON.stringify({ pid: DEAD_PID, mode: "serve", startedAt: 1 }));
    const release = acquireRuntimeLock(dir, "desktop");
    expect(readRuntimeLock(dir)).toMatchObject({ pid: process.pid, mode: "desktop" });
    release();
    expect(readRuntimeLock(dir)).toBeNull();
    expect(fs.existsSync(join(dir, RUNTIME_LOCK_FILE))).toBe(false);
  });

  it("une libération ne supprime pas un verrou repris entre-temps sous le même pid", () => {
    // Un pid recyclé porte le même numéro : `startedAt` est ce qui distingue notre écriture de celle
    // qui a repris le profil. Sans lui, l'ancien détenteur effaçait le verrou du nouveau.
    const dir = tempDir();
    const path = join(dir, RUNTIME_LOCK_FILE);
    const release = acquireRuntimeLock(dir, "desktop", 4242);
    const mine = readRuntimeLock(dir);
    expect(mine, "notre écriture est relue").not.toBeNull();
    fs.writeFileSync(path, JSON.stringify({ pid: 4242, mode: "serve", startedAt: mine!.startedAt + 1_000 }));
    release();
    expect(readRuntimeLock(dir), "le verrou du repreneur reste en place").toMatchObject({ mode: "serve" });
  });
});
