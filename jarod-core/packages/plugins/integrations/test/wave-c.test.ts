import { describe, expect, it } from "vitest";
import { AdapterRefused, AdapterUnavailable, DEFAULT_VAD, detectPii, energyScorer, guardCloudSend, LocalStt, maskPii, segmentSpeech, type SttEngine } from "../src/index.js";

const frame = (amp: number, n = 160) => new Float32Array(n).fill(amp);

describe("C1 — détection d'activité vocale", () => {
  const scorer = (f: Float32Array) => f[0]!; // la « probabilité » est portée par la trame

  it("segmente avec hystérésis : la parole est gardée, le silence et le bruit bref sont écartés", () => {
    const p = [0, 0, 0.9, 0.9, 0.5, 0.9, 0.9, ...Array(10).fill(0), 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const segs = segmentSpeech(p.map((x) => frame(x, 4)), scorer);
    expect(segs).toEqual([{ startFrame: 2, endFrame: 7 }]);
  });

  it("un creux plus court que le délai de maintien ne coupe pas le segment", () => {
    const p = [0.9, 0.9, 0.9, 0, 0, 0, 0.9, 0.9, ...Array(9).fill(0)];
    expect(segmentSpeech(p.map((x) => frame(x, 4)), scorer)).toEqual([{ startFrame: 0, endFrame: 8 }]);
  });

  it("refuse une configuration incohérente et un score invalide", () => {
    expect(() => segmentSpeech([frame(0.5)], scorer, { ...DEFAULT_VAD, stop: 0.9, start: 0.5 })).toThrow(AdapterRefused);
    expect(() => segmentSpeech([frame(0.5)], () => Number.NaN)).toThrow(/invalide/);
  });

  it("le repli par énergie distingue un signal d'un silence", () => {
    const e = energyScorer();
    expect(e(frame(0))).toBe(0);
    expect(e(frame(0.2))).toBe(1);
  });
});

describe("C2 — reconnaissance vocale locale", () => {
  const engine = (over: Partial<SttEngine> = {}): SttEngine => ({ locality: "local", transcribe: async () => ({ text: "  bonjour\u0007 ", confidence: 0.9 }), ...over });
  const pcm = new Float32Array(16000);

  it("transcrit en local et nettoie le texte", async () => {
    expect(await new LocalStt(engine()).transcribe(pcm, 16000)).toBe("bonjour");
  });

  it("sans moteur : indisponible. Moteur distant : refusé tant que l'audio cloud n'est pas explicitement permis", async () => {
    await expect(new LocalStt(undefined).transcribe(pcm, 16000)).rejects.toThrow(AdapterUnavailable);
    await expect(new LocalStt(engine({ locality: "remote" })).transcribe(pcm, 16000)).rejects.toThrow(/ne quitte pas/);
    expect(await new LocalStt(engine({ locality: "remote" }), { allowCloudAudio: true }).transcribe(pcm, 16000)).toBe("bonjour");
  });

  it("refuse fréquence absurde, audio trop long, échantillons invalides ; une faible confiance donne un texte vide", async () => {
    const s = new LocalStt(engine(), { maxSeconds: 1 });
    await expect(s.transcribe(pcm, 100)).rejects.toThrow(/fréquence/);
    await expect(s.transcribe(new Float32Array(32000), 16000)).rejects.toThrow(/long/);
    await expect(s.transcribe(new Float32Array([Number.NaN]), 16000)).rejects.toThrow(/invalides/);
    expect(await new LocalStt(engine({ transcribe: async () => ({ text: "bruit", confidence: 0.1 }) })).transcribe(pcm, 16000)).toBe("");
  });
});

describe("C3 — masquage des données personnelles avant envoi", () => {
  it("masque courriel, carte (Luhn), IBAN (mod 97), NIR (clé), téléphone, IP, et rien d'autre", () => {
    const text = "Écris à jean.dupont@example.com ; carte 4111 1111 1111 1111 ; IBAN FR14 2004 1010 0505 0001 3M02 606 ; NIR 2 84 12 76 451 089 93 ; tel 06 12 34 56 78 ; ip 192.168.1.20 ; fin.";
    const r = maskPii(text);
    expect(r.text).toBe("Écris à [EMAIL] ; carte [CARD] ; IBAN [IBAN] ; NIR [NIR] ; tel [PHONE] ; ip [IP] ; fin.");
    expect(r.counts).toEqual({ email: 1, card: 1, iban: 1, nir: 1, phone: 1, ip: 1 });
  });

  it("une suite de chiffres qui ne passe pas la clé de contrôle n'est pas masquée (peu de faux positifs)", () => {
    const text = "Commande 4111 1111 1111 1112, IBAN FR00 0000 0000 0000, version 1.2.3, total 1234567890123.";
    expect(detectPii(text)).toEqual([]);
    expect(maskPii(text).text).toBe(text);
  });

  it("mesure sur un petit corpus : tout le sensible est masqué, aucun texte bénin n'est modifié", () => {
    const sensitive = ["mail: a.b@c.fr", "CB 5500 0000 0000 0004", "+33 6 12 34 56 78", "10.0.0.1 est le serveur"];
    const benign = ["Le build a réussi en 12 s.", "Rendez-vous le 12/03/2026 à 14h30.", "Référence interne 20260317-001.", "Voir la section 4.2.1 du guide."];
    expect(sensitive.map((t) => maskPii(t).text === t)).toEqual([false, false, false, false]);
    expect(benign.map((t) => maskPii(t).text === t)).toEqual([true, true, true, true]);
  });

  it("limite connue : un nom propre ou une adresse postale ne sont PAS détectés (couche supplémentaire, pas une garantie)", () => {
    expect(maskPii("Jean Dupont habite 12 rue de la Paix, Paris").text).toBe("Jean Dupont habite 12 rue de la Paix, Paris");
  });

  it("la garde d'envoi masque par défaut et ne peut être coupée que explicitement", () => {
    expect(guardCloudSend("x@y.fr").text).toBe("[EMAIL]");
    expect(guardCloudSend("x@y.fr", { enabled: false }).text).toBe("x@y.fr");
  });
});
