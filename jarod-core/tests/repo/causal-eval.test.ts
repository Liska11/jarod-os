// SPECS-P5-CAUSAL.md §10 : machinerie de la mesure de la mémoire causale — fonctions pures + petit corpus synthétique (index FTS5 réels en mémoire).
import { describe, expect, it } from "vitest";
import { actionKey, actionText, calibrate, collectRecords, coveragePasses, type Episode, FROZEN, FtsIndex, ftsQueryOf, isQualifiedTarget, measureAt, type RawMessage, runMeasure, tokenize, tokenizeAll } from "../bench/causal-eval.js";

const ep = (o: Partial<Episode> & Pick<Episode, "id" | "sessionId">): Episode => ({
  tool: "terminal",
  situation: "",
  action: "",
  kind: "succes",
  text: "",
  signature: null,
  ...o,
});
const SIG_DEPLOY = "ssh|permission denied: ./deploy.sh";

describe("constantes figées", () => {
  it("top-3, 64 termes de requête, 500 / 300 caractères de situation / action, 4000 de message indexé, clé d'action de 80", () => {
    expect(FROZEN).toEqual({ topK: 3, maxQueryTokens: 64, situationChars: 500, actionChars: 300, indexMessageChars: 4000, actionKeyChars: 80 });
  });
});

describe("texte d'action, termes, requête", () => {
  it("actionText : outil + valeurs de l'objet d'arguments, ou l'argument brut ; coupé à 300", () => {
    expect(actionText("terminal", JSON.stringify({ command: "cd /srv/rag && ./deploy.sh", timeout: 30 }))).toBe("terminal cd /srv/rag && ./deploy.sh 30");
    expect(actionText("read_file", "chemin brut")).toBe("read_file chemin brut");
    expect(actionText(null, "")).toBe("?");
    expect(actionText("terminal", JSON.stringify({ command: "x".repeat(500) })).length).toBe(FROZEN.actionChars);
  });

  it("tokenize : minuscules, sans accents, mots de 2 caractères et plus, distincts, 64 au plus", () => {
    expect(tokenize("Déployer LE service-RAG; le service RAG a échoué (x)")).toEqual(["deployer", "le", "service", "rag", "echoue"]);
    expect(tokenize(Array.from({ length: 200 }, (_, i) => `mot${i}`).join(" "))).toHaveLength(FROZEN.maxQueryTokens);
  });

  it("ftsQueryOf : OU de termes entre guillemets (aucune syntaxe FTS5 injectable) ; vide → null", () => {
    expect(ftsQueryOf(["a1", "b2"])).toBe('"a1" OR "b2"');
    expect(ftsQueryOf([])).toBeNull();
  });

  it("actionKey : action normalisée (chemins, nombres) sur 80 caractères", () => {
    expect(actionKey("terminal", JSON.stringify({ command: "cd /d/a/b && ls 12" }))).toBe(actionKey("terminal", JSON.stringify({ command: "cd /s/z/y && ls 99" })));
    expect(actionKey("terminal", "x".repeat(300)).length).toBeLessThanOrEqual(FROZEN.actionKeyChars);
  });
});

describe("FtsIndex", () => {
  it("classe par pertinence, rend au plus k, ignore une requête vide", () => {
    const idx = new FtsIndex();
    idx.add("a", "déployer le service rag sur le serveur");
    idx.add("b", "lancer les tests du module voix");
    idx.add("c", "déployer un autre service");
    expect(idx.search('"deployer" OR "rag" OR "serveur"', 2)[0]).toBe("a");
    expect(idx.search('"deployer"', 5).sort()).toEqual(["a", "c"]);
    expect(idx.search('"inexistant"', 3)).toEqual([]);
    expect(idx.search(null, 3)).toEqual([]);
    idx.close();
  });
});

describe("cibles : recensement des échecs qualifiés", () => {
  const train = [
    ep({ id: "e1", sessionId: "S1", kind: "echec", text: "permission denied: ./deploy.sh", signature: SIG_DEPLOY }),
    ep({ id: "e3", sessionId: "S3", kind: "echec", text: "file not found: <chemin>", signature: "read_file|file not found: <chemin>", tool: "read_file" }),
  ];
  const bySig = new Map<string, Episode[]>();
  for (const e of train) bySig.set(e.signature!, [...(bySig.get(e.signature!) ?? []), e]);

  it("qualifiée = échec AVEC texte dont la signature a été vue dans une AUTRE conversation d'apprentissage", () => {
    expect(isQualifiedTarget(ep({ id: "t1", sessionId: "S9", kind: "echec", text: "permission denied: ./deploy.sh", signature: SIG_DEPLOY }), bySig)).toBe(true);
    expect(isQualifiedTarget(ep({ id: "t2", sessionId: "S1", kind: "echec", text: "permission denied: ./deploy.sh", signature: SIG_DEPLOY }), bySig)).toBe(false); // même conversation
    expect(isQualifiedTarget(ep({ id: "t3", sessionId: "S9", kind: "echec", text: "", signature: "terminal|exit=1" }), bySig)).toBe(false); // sans texte
    expect(isQualifiedTarget(ep({ id: "t4", sessionId: "S9", kind: "echec", text: "autre", signature: "terminal|autre" }), bySig)).toBe(false); // jamais vue
    expect(isQualifiedTarget(ep({ id: "t5", sessionId: "S9", kind: "succes" }), bySig)).toBe(false);
  });
});

describe("runMeasure sur un corpus synthétique", () => {
  const train: Episode[] = [
    ep({ id: "e1", sessionId: "S1", situation: "déployer le service rag sur le serveur", action: "ssh cd /srv/rag && ./deploy.sh", tool: "ssh", kind: "echec", text: "permission denied: ./deploy.sh", signature: SIG_DEPLOY }),
    ep({ id: "e2", sessionId: "S2", situation: "lancer les tests du module voix", action: "terminal pnpm test voice", kind: "succes" }),
    ep({ id: "e3", sessionId: "S3", situation: "lire la configuration yaml", action: "read_file config.yaml", tool: "read_file", kind: "echec", text: "file not found: config.yaml", signature: "read_file|file not found: <chemin>" }),
  ];
  const test: Episode[] = [
    // cible 1 : même signature que e1, autre conversation, requête proche → la voie testée la retrouve
    ep({ id: "t1", sessionId: "S9", situation: "relancer le déploiement du service rag sur le serveur", action: "ssh cd /srv/rag && ./deploy.sh", tool: "ssh", kind: "echec", text: "permission denied: ./deploy.sh", signature: SIG_DEPLOY }),
    // cible 2 : même signature que e3 mais requête sans rapport lexical → manquée
    ep({ id: "t2", sessionId: "S8", situation: "vérifier quelque chose", action: "ouvrir paramètres.toml", tool: "read_file", kind: "echec", text: "file not found: paramètres.toml", signature: "read_file|file not found: <chemin>" }),
    // non cibles : même conversation, sans texte, signature jamais vue
    ep({ id: "t3", sessionId: "S1", situation: "déployer", action: "ssh ./deploy.sh", tool: "ssh", kind: "echec", text: "permission denied: ./deploy.sh", signature: SIG_DEPLOY }),
    ep({ id: "t4", sessionId: "S7", kind: "echec", text: "", signature: "terminal|exit=1" }),
    // hors cibles (réussites dont l'action n'a jamais échoué) : l'une proche d'un échec passé (fausse alerte), l'autre sans rapport
    ep({ id: "o1", sessionId: "S6", situation: "déployer le service rag", action: "ssh ls /srv/rag", tool: "ssh", kind: "succes" }),
    ep({ id: "o2", sessionId: "S5", situation: "lancer les tests du module voix", action: "terminal pnpm test voice", kind: "succes" }),
  ];
  const messages: RawMessage[] = [
    { id: "m1", sessionId: "S1", role: "user", content: "déployer le service rag sur le serveur" },
    { id: "m2", sessionId: "S1", role: "tool", content: '{"output": "permission denied: ./deploy.sh", "exit_code": 126}', failureOf: train[0]! },
    { id: "m3", sessionId: "S2", role: "user", content: "lancer les tests du module voix" },
    { id: "m4", sessionId: "S3", role: "tool", content: '{"output": "file not found: config.yaml", "exit_code": 1}', failureOf: train[2]! },
  ];

  it("compte les cibles, les réussites de chaque voie, les hors cibles et les fausses alertes", () => {
    const r = runMeasure({ train, test, trainMessages: messages });
    expect(r.measure.targets).toBe(2);
    expect(r.measure.systemHits).toBe(1);
    // Référence (messages bruts) : la requête de t1 retrouve le message-résultat m2 (échec de même signature) ; celle de t2 ne retrouve rien.
    expect(r.measure.baselineHits).toBe(1);
    expect(r.measure.offTargets).toBe(2);
    expect(r.measure.falseAlarms).toBe(1); // o1 ramène e1 (un échec) ; o2 ne ramène que e2 (une réussite)
    expect(r.details.unqualified).toBe(2);
  });

  it("mode `failures` : l'index ne contient que les échecs avec texte (aucune réussite ne prend la place d'un échec)", () => {
    const mixed = runMeasure({ train, test, trainMessages: messages });
    const failuresOnly = runMeasure({ train, test, trainMessages: messages, indexMode: "failures" });
    expect(mixed.details.indexedEpisodes).toBe(3);
    expect(failuresOnly.details.indexedEpisodes).toBe(2);
    expect(failuresOnly.measure.systemHits).toBeGreaterThanOrEqual(mixed.measure.systemHits);
    expect(failuresOnly.measure.targets).toBe(mixed.measure.targets);
  });

  it("une réponse issue de la MÊME conversation que la cible ne compte pas comme réussite", () => {
    const sameSession = test.map((e) => (e.id === "t1" ? { ...e, sessionId: "S1" } : e));
    const r = runMeasure({ train, test: sameSession, trainMessages: messages });
    expect(r.measure.targets).toBe(1); // t1 n'est plus une cible
  });
});

describe("porte de couverture (option B) : un échec n'est proposé que si une fraction c des termes de la requête figure dans son texte", () => {
  it("tokenizeAll : sans plafond de 64 (la couverture se mesure sur le texte entier de l'épisode)", () => {
    expect(tokenizeAll(Array.from({ length: 200 }, (_, i) => `mot${i}`).join(" "))).toHaveLength(200);
  });

  it("coveragePasses : comparaison EXACTE en entiers (num/den ≥ c %), null ne passe jamais", () => {
    expect(coveragePasses({ num: 3, den: 4 }, 75)).toBe(true);
    expect(coveragePasses({ num: 3, den: 4 }, 76)).toBe(false);
    expect(coveragePasses({ num: 0, den: 4 }, 0)).toBe(true);
    expect(coveragePasses(null, 0)).toBe(false);
    expect(coveragePasses({ num: 1, den: 3 }, 33)).toBe(true); // 33,33… ≥ 33
    expect(coveragePasses({ num: 1, den: 3 }, 34)).toBe(false);
  });

  // Corpus où la couverture est connue : la requête de t1 a 6 termes distincts, l'épisode e1 en contient 4 (66,7 %).
  const train: Episode[] = [
    ep({ id: "e1", sessionId: "S1", situation: "alpha beta", action: "gamma delta", kind: "echec", text: "oups", signature: "x|oups" }),
    ep({ id: "e2", sessionId: "S2", situation: "alpha zeta", action: "eta theta", kind: "echec", text: "autre", signature: "x|autre" }),
  ];
  const test: Episode[] = [
    ep({ id: "t1", sessionId: "S9", situation: "alpha beta", action: "gamma delta epsilon omega", kind: "echec", text: "oups", signature: "x|oups" }),
    ep({ id: "o1", sessionId: "S8", situation: "alpha beta", action: "gamma delta epsilon omega", kind: "succes" }),
    ep({ id: "o2", sessionId: "S7", situation: "zeta", action: "inconnu1 inconnu2 inconnu3", kind: "succes" }),
  ];

  it("collectRecords : une cible garde la meilleure couverture de sa réussite, une action réussie celle de son meilleur échec proposé", () => {
    const r = collectRecords({ train, test, trainMessages: [], indexMode: "failures" });
    expect(r.records.targets).toHaveLength(1);
    expect(r.records.targets[0]!.hitCoverage).toEqual({ num: 4, den: 6 });
    // o1 : même requête que t1 → mêmes 4/6 sur e1 ; o2 : « zeta » seul parmi 4 termes sur e2 → 1/4
    const cov = r.records.offTargets.map((o) => o.maxCoverage);
    expect(cov).toContainEqual({ num: 4, den: 6 });
    expect(cov).toContainEqual({ num: 1, den: 4 });
  });

  it("measureAt : la porte retire des réussites ET des fausses alertes ; à c = 0 elle reproduit le comportement sans porte", () => {
    const r = collectRecords({ train, test, trainMessages: [], indexMode: "failures" });
    const open = measureAt(r.records, 0);
    expect(open).toMatchObject({ targets: 1, systemHits: 1, offTargets: 2, falseAlarms: 2 });
    expect(open).toEqual(runMeasure({ train, test, trainMessages: [], indexMode: "failures" }).measure);
    // 1/4 = 25 % < 26 → o2 ne déclenche plus ; 4/6 (66,7 %) passe encore
    const g = measureAt(r.records, 26);
    expect(g.falseAlarms).toBe(1);
    expect(measureAt(r.records, 67)).toMatchObject({ systemHits: 0, falseAlarms: 0 }); // 66,7 < 67
  });

  it("calibrate : plus petit c dont la précision hors cibles atteint la cible ; courbe 0…100 ; rien d'atteignable → null", () => {
    const r = collectRecords({ train, test, trainMessages: [], indexMode: "failures" });
    const c = calibrate(r.records, 50);
    expect(c.curve).toHaveLength(101);
    expect(c.curve[0]).toMatchObject({ c: 0, falseAlarms: 2, hits: 1 });
    expect(c.chosenPercent).toBe(26); // à 26 un seul des deux hors-cibles alerte → précision 50 %
    expect(calibrate(r.records, 100).chosenPercent).toBe(67); // plus aucune alerte à 67 %
    // précision monotone non décroissante avec c
    for (let i = 1; i < c.curve.length; i++) expect(c.curve[i]!.precisionPercent).toBeGreaterThanOrEqual(c.curve[i - 1]!.precisionPercent);
    const none = collectRecords({ train, test: [ep({ id: "x", sessionId: "S5", situation: "alpha", action: "beta", kind: "succes" })], trainMessages: [], indexMode: "failures" });
    expect(calibrate(none.records, 101).chosenPercent).toBeNull();
  });
});
