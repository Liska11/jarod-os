// G5 — contrat sans moteur : choix de piste (originale / automatique jamais confondues), texte des sous-titres, adresses refusées.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admitMediaFile, checkMediaUrl, type MediaInfo, pickTrack, safeUrl, subtitleText } from "../src/impl/media.js";

const info = (subtitles: string[], automaticCaptions: string[]): MediaInfo => ({ title: "t", isLive: false, page: "p", subtitles, automaticCaptions });

describe("G5 — piste de sous-titres", () => {
  it("l'originale d'abord ; l'automatique seulement si elle est demandée, et dite automatique", () => {
    expect(pickTrack(info(["fr"], ["fr", "en"]), ["fr"], true)).toEqual({ lang: "fr", origin: "original" });
    expect(pickTrack(info([], ["fr"]), ["fr"], false)).toBeNull();
    expect(pickTrack(info([], ["fr"]), ["fr"], true)).toEqual({ lang: "fr", origin: "automatique" });
    expect(pickTrack(info(["en-US"], []), ["en"], false)).toEqual({ lang: "en-US", origin: "original" });
    expect(pickTrack(info(["de"], []), ["fr", "en"], true)).toBeNull();
  });

  it("le texte n'a ni en-tête, ni horodatage, ni numéro, ni balise, ni répétition", () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\n<i>Salut</i> &amp; bienvenue\n\n2\n00:00:01,000 --> 00:00:02,000\n<i>Salut</i> &amp; bienvenue\n\n3\n00:00:02,000 --> 00:00:03,000\nFin.\n";
    expect(subtitleText(srt)).toBe("Salut & bienvenue\nFin.");
    expect(subtitleText("WEBVTT\nKind: captions\nLanguage: fr\n\n00:00.000 --> 00:01.000 align:start\nA<00:00:00.500><c> b</c>\n")).toBe("A b");
  });
});

describe("G5 — adresses", () => {
  it("refuse bouclage, réseaux privés, lien local, identifiants, autres schémas ; accepte un hôte public", () => {
    for (const u of ["http://127.0.0.1/x", "http://localhost:8080/", "http://10.0.0.2/", "http://192.168.1.10/", "http://172.20.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://nas.local/", "http://100.64.1.1/"])
      expect(() => checkMediaUrl(u), u).toThrow(/local ou privé/);
    expect(() => checkMediaUrl("https://a:b@video.example/")).toThrow(/identifiants/);
    expect(() => checkMediaUrl("ftp://video.example/")).toThrow(/http/);
    expect(checkMediaUrl("https://video.example/watch?v=1").hostname).toBe("video.example");
  });

  it("une adresse rendue ne garde jamais la requête ni le fragment", () => {
    expect(safeUrl(new URL("https://video.example/w?token=abc#t=1"))).toBe("https://video.example/w");
  });
});

describe("V-07 — ce que media_fetch rapporte passe par la quarantaine", () => {
  it("admis : rangé dans .jarod-media du dossier de travail, avec l'URL pour provenance ; sans quarantaine : refusé", () => {
    const calls: unknown[][] = [];
    const admit = (source: string, provenance: { source: string; url?: string }, destDir: string) => {
      calls.push([source, provenance, destDir]);
      return join(destDir, "v.vtt");
    };
    expect(admitMediaFile("T:/transit/v.vtt", "https://video.example/1", "W:/espace", admit)).toBe(join("W:/espace", ".jarod-media", "v.vtt"));
    expect(calls).toEqual([["T:/transit/v.vtt", { source: "media_fetch", url: "https://video.example/1" }, join("W:/espace", ".jarod-media")]]);
    expect(() => admitMediaFile("T:/transit/v.vtt", "https://video.example/1", "W:/espace", null)).toThrow(/quarantaine n'est pas chargée/);
    expect(() => admitMediaFile("x", "u", "w", () => { throw new Error("refusé par la quarantaine : menace détectée"); })).toThrow(/menace/);
  });
});
