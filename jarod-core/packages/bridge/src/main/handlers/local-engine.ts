/**
 * Moteur local llama.cpp (SPECS-P5-UI-PARITE.md §3.5) : canaux PROPRES à Jarod `local-engine-*`. Le moteur (`EngineService` de plugin-llm : installation,
 * préréglages, démarrage) n'avait aucun canal : l'utilisateur éditait `localEngine` à la main, `extraArgs` compris. Ici l'écran ne montre que des
 * champs STRUCTURÉS, et l'estimation « tient-il ? » vient de la bibliothèque `gguf-fit` (SPECS-P5-GGUF-FIT.md), pas de l'écran.
 *
 * Règles :
 * - AUCUN chemin ne vient du renderer : le modèle (et le brouillon) se choisissent dans la boîte « Ouvrir » NATIVE, qui les écrit elle-même dans le
 *   préréglage ; un préréglage envoyé par l'écran doit REPRENDRE les chemins déjà enregistrés (ou vider le brouillon) — sinon refus ;
 * - AUCUN argument libre : `extraArgs` ne se tape pas. L'écran peut seulement le garder tel quel ou le vider (un argument tel que `--host 0.0.0.0` placé
 *   là gagnerait contre le `--host 127.0.0.1` de Jarod et ouvrirait le serveur au réseau) ; les seuls réglages sont des champs bornés, jugés ici ;
 * - télécharger le moteur (binaire du dépôt officiel ggml-org/llama.cpp, empreinte SHA-256 vérifiée quand GitHub la publie) passe par une boîte NATIVE
 *   qui dit d'où, et ce que ça remplace ; annulable ;
 * - l'estimation de mémoire est une INDICATION : marge de calcul non mesurée (SPECS-P5-GGUF-FIT.md), jamais un blocage — démarrer n'est pas conditionné
 *   à `fits`. Le cache KV est toujours rendu à part du poids ;
 * - le serveur n'écoute que sur 127.0.0.1 (`LlamaServerSupervisor`) ; un seul téléchargement à la fois.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { EngineBackend, EnginePreset, LocalEngineConfig } from "@jarod/contracts";
import { type FitReport, newPreset, reportGgufFit } from "@jarod/plugin-llm";
import { type EngineBudgetBasis, engineBudget } from "../engine-budget.js";
import type { HandlerContext } from "./context.js";

const GIB = 1024 ** 3;
const MAX_PRESETS = 20;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const FLASH = ["auto", "on", "off"] as const;
const CACHE = ["f16", "q8_0", "q4_0"] as const;
const REASONING = ["auto", "on", "off", "deepseek"] as const;

export type { EngineBudgetBasis };

export interface EngineView {
  installed: { tag: string; backend: EngineBackend; at: number; present: boolean } | null;
  installing: boolean;
  backend: EngineBackend | "";
  detectedBackend: EngineBackend;
  port: number;
  autoStart: boolean;
  activePreset: string;
  presets: (EnginePreset & { modelName: string; modelPresent: boolean; draftModelName: string })[];
  server: { running: boolean; ready: boolean; port: number | null; model: string | null; restarts: number; lastError: string | null };
  logs: string[];
  hardware: { cpu: string; ramGb: number; gpus: { name: string; vramGb: number | null; kind: string }[]; budgetGb: number; budgetBasis: EngineBudgetBasis };
}

export interface EngineFitView extends FitReport {
  budgetBytes: number;
  budgetBasis: EngineBudgetBasis;
}

const bad = (why: string): never => {
  throw new Error(`[oneai] moteur local : ${why}`);
};

function int(label: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return bad(`« ${label} » : entier entre ${min} et ${max} attendu`);
  return v;
}

function ratio(label: string, v: unknown, max: number): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) return bad(`« ${label} » : nombre entre 0 et ${max}, ou vide`);
  return v;
}

function oneOf<T extends string>(label: string, v: unknown, allowed: readonly T[]): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : bad(`« ${label} » : une valeur parmi ${allowed.join(", ")}`);
}

/** Les champs de réglage d'un préréglage (hors chemins et arguments) : bornés, jamais « ramenés » à une valeur voisine. */
interface Tuning {
  ctxSize: number;
  gpuLayers: number;
  flashAttn: EnginePreset["flashAttn"];
  cacheType: EnginePreset["cacheType"];
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  reasoning: EnginePreset["reasoning"];
  parallelSlots: number | undefined;
}

function tuning(o: Record<string, unknown>): Tuning {
  return {
    ctxSize: int("ctxSize", o.ctxSize, 512, 2_097_152),
    gpuLayers: int("gpuLayers", o.gpuLayers, -1, 999),
    flashAttn: oneOf("flashAttn", o.flashAttn, FLASH),
    cacheType: oneOf("cacheType", o.cacheType, CACHE),
    temperature: ratio("temperature", o.temperature, 5),
    topP: ratio("topP", o.topP, 1),
    topK: o.topK === null ? null : int("topK", o.topK, 0, 1000),
    minP: ratio("minP", o.minP, 1),
    reasoning: oneOf("reasoning", o.reasoning, REASONING),
    parallelSlots: o.parallelSlots === undefined || o.parallelSlots === null ? undefined : int("parallelSlots", o.parallelSlots, 1, 16),
  };
}

const PRESET_KEYS = new Set(["id", "name", "model", "draftModel", "extraArgs", "ctxSize", "gpuLayers", "flashAttn", "cacheType", "temperature", "topP", "topK", "minP", "reasoning", "parallelSlots", "modelName", "modelPresent", "draftModelName"]);
// Les trois derniers sont des champs d'AFFICHAGE que `status` ajoute : un écran qui renvoie l'objet reçu tel quel ne doit pas être refusé pour cela.

export function createLocalEngineHandlers(ctx: HandlerContext) {
  const port = () => {
    const p = ctx.kernel().localEngine;
    if (!p) throw new Error("[oneai] moteur local indisponible (plugin-llm désactivé)");
    return p;
  };
  const engine = () => port().engine;
  let installing: AbortController | null = null;

  const budget = async (): Promise<{ bytes: number; basis: EngineBudgetBasis; hw: Awaited<ReturnType<ReturnType<typeof port>["hardware"]>> }> => {
    const hw = await port().hardware();
    return { ...engineBudget(hw), hw };
  };

  const view = async (): Promise<EngineView> => {
    const eng = engine();
    const cfg: LocalEngineConfig = eng.config();
    const st = eng.status();
    const b = await budget();
    return {
      installed: cfg.installed ? { tag: cfg.installed.tag, backend: cfg.installed.backend, at: cfg.installed.at, present: existsSync(cfg.installed.bin) } : null,
      installing: installing !== null,
      backend: cfg.backend,
      detectedBackend: await eng.detectedBackend(),
      port: cfg.port,
      autoStart: cfg.autoStart,
      activePreset: cfg.activePreset,
      presets: cfg.presets.map((p) => ({ ...p, modelName: basename(p.model), modelPresent: Boolean(p.model) && existsSync(p.model), draftModelName: p.draftModel ? basename(p.draftModel) : "" })),
      server: { running: st.server.running, ready: st.server.ready, port: st.server.port, model: st.server.model, restarts: st.server.restarts, lastError: st.server.lastError },
      logs: st.logs.slice(-30),
      hardware: {
        cpu: b.hw.cpu,
        ramGb: b.hw.ramGb,
        gpus: b.hw.gpus.map((g) => ({ name: g.name, vramGb: g.vramGb, kind: g.kind ?? "cpu" })),
        budgetGb: Math.round((b.bytes / GIB) * 10) / 10,
        budgetBasis: b.basis,
      },
    };
  };

  const stored = (id: unknown): EnginePreset => {
    if (typeof id !== "string" || !ID.test(id)) return bad("identifiant de préréglage attendu");
    return engine().config().presets.find((p) => p.id === id) ?? bad("préréglage inconnu");
  };

  const pickGguf = async (title: string): Promise<string | null> => {
    if (!ctx.shell.pickFile) return bad("boîte « Ouvrir » native indisponible, refusé");
    const file = await ctx.shell.pickFile({ title, filters: [{ name: "Modèle GGUF", extensions: ["gguf"] }] });
    if (!file) return null;
    if (!file.toLowerCase().endsWith(".gguf")) return bad("ce n'est pas un fichier .gguf");
    if (!existsSync(file)) return bad("fichier introuvable");
    return file;
  };

  const write = (presets: EnginePreset[], active: string): void => void engine().savePresets(presets, active);

  return {
    "local-engine-status": (): Promise<EngineView> => view(),

    /** Réglages hors préréglages : port, moteur, démarrage automatique, préréglage actif — validés par le service. */
    "local-engine-configure": async (patch: unknown): Promise<EngineView> => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return bad("réglages attendus");
      const o = patch as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !["port", "backend", "autoStart", "activePreset"].includes(k));
      if (extra.length) return bad(`champ(s) non accepté(s) : ${extra.join(", ")}`);
      engine().configure({
        ...(o.port === undefined ? {} : { port: o.port as number }),
        ...(o.backend === undefined ? {} : { backend: o.backend as EngineBackend | "" }),
        ...(o.autoStart === undefined ? {} : { autoStart: o.autoStart as boolean }),
        ...(o.activePreset === undefined ? {} : { activePreset: o.activePreset as string }),
      });
      return view();
    },

    /**
     * Télécharge (ou met à jour) le moteur. Boîte native d'abord : d'où ça vient, ce qui est remplacé, ce que ça arrête. Progression : événement
     * `local-engine-progress`. `local-engine-install-cancel` l'interrompt (le moteur précédent reste en place).
     */
    "local-engine-install": async (): Promise<EngineView> => {
      if (installing) return bad("une installation est déjà en cours");
      const eng = engine();
      const cfg = eng.config();
      const backend = cfg.backend || (await eng.detectedBackend());
      const replacing = cfg.installed && existsSync(cfg.installed.bin) ? cfg.installed : null;
      if (!ctx.shell.confirm) return bad("confirmation native indisponible, refusé");
      const ok = await ctx.shell.confirm(
        replacing ? "Mettre à jour le moteur llama.cpp ?" : "Télécharger le moteur llama.cpp ?",
        `Jarod va télécharger la dernière version publiée de llama.cpp (moteur « ${backend} ») depuis github.com/ggml-org/llama.cpp, vérifier le fichier avec l'empreinte SHA-256 que GitHub publie quand elle existe, puis l'installer dans son dossier de données.\n\n` +
          (replacing ? `L'installation actuelle (${replacing.tag}, ${replacing.backend}) sera remplacée ; le serveur local sera arrêté s'il tourne.\n\n` : "") +
          "La taille dépend du moteur choisi. Le téléchargement peut être annulé.",
        replacing ? "Mettre à jour" : "Télécharger",
      );
      if (!ok) return bad("refusé par l'utilisateur");
      const controller = new AbortController();
      installing = controller;
      const progress = (p: unknown) => ctx.shell.send("local-engine-progress", p);
      try {
        if (replacing) await eng.update(progress, controller.signal);
        else await eng.install(progress, controller.signal);
      } catch (e) {
        if (controller.signal.aborted) return bad("installation annulée");
        throw e;
      } finally {
        installing = null;
      }
      return view();
    },

    "local-engine-install-cancel": (): boolean => {
      installing?.abort();
      return installing !== null;
    },

    /** Boîte « Ouvrir » native : un NOUVEAU préréglage autour du modèle choisi (nom = nom du fichier). Null si la boîte est annulée. */
    "local-engine-add-preset": async (): Promise<EngineView | null> => {
      const cfg = engine().config();
      if (cfg.presets.length >= MAX_PRESETS) return bad(`${MAX_PRESETS} préréglages au plus`);
      const file = await pickGguf("Modèle GGUF");
      if (!file) return null;
      const preset = newPreset({ id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: basename(file).replace(/\.gguf$/i, "").slice(0, 60) || "Préréglage", model: file, parallelSlots: 1 });
      write([...cfg.presets, preset], cfg.activePreset || preset.id);
      return view();
    },

    /** Boîte « Ouvrir » native : remplace le modèle ou le brouillon d'un préréglage. Null si la boîte est annulée. */
    "local-engine-pick-model": async (id: unknown, field: unknown): Promise<EngineView | null> => {
      const target = stored(id);
      const which = oneOf("champ", field, ["model", "draftModel"] as const);
      const file = await pickGguf(which === "model" ? "Modèle GGUF" : "Modèle de brouillon (même famille, plus petit)");
      if (!file) return null;
      const cfg = engine().config();
      write(cfg.presets.map((p) => (p.id === target.id ? { ...p, [which]: file } : p)), cfg.activePreset);
      return view();
    },

    /**
     * Enregistre les réglages d'un préréglage EXISTANT. Chemins : ceux déjà enregistrés (le brouillon peut être vidé) ; `extraArgs` : gardé tel quel
     * ou vidé ; tout champ inconnu est refusé. Un serveur en marche garde l'ancien chargement jusqu'au prochain démarrage.
     */
    "local-engine-preset-save": async (input: unknown): Promise<EngineView> => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return bad("préréglage attendu");
      const o = input as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !PRESET_KEYS.has(k));
      if (extra.length) return bad(`champ(s) non accepté(s) : ${extra.join(", ")}`);
      const current = stored(o.id);
      if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 60 || /[\u0000-\u001f]/.test(o.name)) return bad("nom : 1 à 60 caractères, sans caractère de contrôle");
      if (o.model !== current.model) return bad("le modèle ne se change que par la boîte « Ouvrir » (« Choisir le modèle… »)");
      if (o.draftModel !== current.draftModel && o.draftModel !== "") return bad("le brouillon ne se change que par la boîte « Ouvrir » ; le vider est permis");
      const args = o.extraArgs;
      if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return bad("« extraArgs » : liste attendue");
      if (args.length && JSON.stringify(args) !== JSON.stringify(current.extraArgs)) return bad("les arguments avancés ne se tapent pas : ils se gardent ou se suppriment");
      const t = tuning(o);
      const next: EnginePreset = { ...current, name: o.name.trim(), draftModel: o.draftModel as string, extraArgs: args as string[], ...t };
      if (t.parallelSlots === undefined) delete next.parallelSlots;
      const cfg = engine().config();
      write(cfg.presets.map((p) => (p.id === current.id ? next : p)), cfg.activePreset);
      return view();
    },

    "local-engine-preset-remove": async (id: unknown): Promise<EngineView> => {
      const target = stored(id);
      const cfg = engine().config();
      write(cfg.presets.filter((p) => p.id !== target.id), cfg.activePreset === target.id ? "" : cfg.activePreset);
      return view();
    },

    /** Charge un préréglage (le modèle peut être long à charger : la réponse attend que le serveur réponde). */
    "local-engine-start": async (id: unknown): Promise<EngineView> => {
      const presetId = id === undefined || id === null || id === "" ? undefined : stored(id).id;
      await engine().start(presetId);
      return view();
    },

    "local-engine-stop": async (): Promise<EngineView> => {
      await engine().stop();
      return view();
    },

    /**
     * « Ce préréglage tient-il ? » : le rapport de `gguf-fit` pour le modèle ENREGISTRÉ du préréglage, avec les réglages en cours d'édition. Une indication :
     * la marge de calcul n'est pas mesurée, aucun verdict ne bloque le démarrage.
     */
    "local-engine-fit": async (input: unknown): Promise<EngineFitView> => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return bad("demande attendue");
      const o = input as Record<string, unknown>;
      const current = stored(o.id);
      const t = tuning({ ...current, ...o });
      const b = await budget();
      const report = await reportGgufFit(current.model, {
        contextTokens: t.ctxSize,
        cacheType: t.cacheType,
        parallelSlots: t.parallelSlots ?? null,
        gpuBytes: b.bytes,
        gpuLayers: t.gpuLayers,
        draftModel: Boolean(current.draftModel),
      });
      return { ...report, budgetBytes: b.bytes, budgetBasis: b.basis };
    },
  };
}
