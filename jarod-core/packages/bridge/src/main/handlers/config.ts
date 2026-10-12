/**
 * Réglages lus par les écrans SANK-UI au démarrage et dans le Chat (D1(b)) : langue de l'interface, mode de
 * connexion, valeurs de config, modèle actif, préparation du chat, bilan de configuration, tableau de bord.
 * Sources (rév. 3aaadb0, MIT © github.com/fathah) : `src/main/ipc/register.ts:971-974,985-995,1050-1055,
 * 1083-1099,1310,1998-2000` ; `locale.ts:1-41` ; `config.ts:90-105,536-547,708-734` ; `hermes.ts:147-150` ;
 * `validation.ts:28-157` ; `config-health.ts:45-120,270-322,388-424` ; `dashboard.ts:49-56,587-610` ;
 * écritures : `register.ts:1057-1068,1101-1200`, `useModelConfig.ts:18-25,160-195`, `useReasoningEffort.ts:1-22,62-80`.
 *
 * Écarts assumés (Jarod n'a ni `config.yaml`, ni `.env`, ni backend Python Hermes) :
 * - langue de l'INTERFACE = préférence de l'application dans `<racine>/desktop.json` (comme `desktop.json` de
 *   HERMES_HOME), liste `APP_LOCALES` de SANK-UI ; distincte du réglage `language` (fr|en) du kernel, qui est
 *   la langue de l'agent et de la dictée — le DTO n'est pas touché ;
 * - `get-config` : seules les clés qui ont un équivalent Jarod sont lues (`CONFIG_KEYS`) ; toute autre rend
 *   `null`, la réponse de SANK-UI pour une clé absente de `config.yaml` (l'écran applique son défaut) ;
 * - `set-config` : même table (`CONFIG_WRITERS`) ; une clé sans équivalent, ou une valeur hors des valeurs
 *   Jarod (`minimal` : élargir le DTO = 5d), LÈVE — jamais « true » pour une écriture qui n'a pas eu lieu ;
 * - `set-model-config` : réglages `activeProvider` / `activeModel` (modèle GLOBAL : les conversations sans choix
 *   propre le suivent au message suivant, `chat.ts`) ; fournisseur hors catalogue refusé ; l'URL n'est retenue
 *   que pour `custom` (comme `effectiveOverrideBaseUrl` du Chat) → `providerOverrides.custom.baseUrl` : pour un
 *   fournisseur du catalogue elle est ignorée (ce canal ne peut pas envoyer la clé d'un fournisseur vers un
 *   autre hôte) ; taille de contexte / `api_mode` de la bibliothèque sans équivalent ; pas de redémarrage de
 *   passerelle (le kernel lit le modèle à chaque tour) ;
 * - modèle actif = réglages `activeProvider` / `activeModel` + URL du fournisseur (catalogue + surcharge) ;
 * - préparation / bilan : clé = coffre de secrets du kernel (`ProviderRouter`, « configuré » = clé OU
 *   fournisseur local), jamais une variable d'environnement ; les contrôles propres aux fichiers Hermes
 *   (`API_SERVER_KEY`, HERMES_HOME voisin, nom de toolset) n'ont pas d'objet ici et ne sont pas simulés ;
 * - tableau de bord Hermes (processus Python + WebSocket) : absent → `supported: false` (la forme de SANK-UI
 *   pour une plateforme sans tableau de bord) ; le chat passe par l'IPC.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppLocale } from "../../sank/src/shared/i18n/types.js";
import { APP_LOCALES, DEFAULT_ACTIVE_LOCALE } from "../../sank/src/shared/i18n/config.js";
import { isLocalBaseUrl } from "../../sank/src/shared/url-key-map.js";
import type { Effort } from "@jarod/contracts";
import { assertProfile, type DesktopKernel, type HandlerContext } from "./context.js";

/** `config.ts:90-105` : `desktop.json` de l'application (BOM toléré, illisible = vide). */
export function desktopConfigFile(kernel: DesktopKernel): string {
  return join(kernel.dataRoot, "desktop.json");
}

export function readDesktopConfig(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf-8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeDesktopConfig(file: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

const DESKTOP_LOCALE_KEY = "locale";

function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && APP_LOCALES.includes(value as AppLocale);
}

type Settings = DesktopKernel["agent"]["settings"];

/** Clés de `config.yaml` lues par les écrans qui ont un équivalent dans les réglages Jarod. */
const CONFIG_KEYS: Record<string, (s: Settings) => string | null> = {
  // useReasoningEffort.ts : "" (Jarod : laisser le modèle décider) = non réglé → défaut de l'écran (« auto »).
  "agent.reasoning_effort": (s) => s.get("effort") || null,
  // Voice settings (SPECS-P5-VOICE-PANE.md)
  "voice.autoSpeak": (s) => s.get("voice")?.autoSpeak != null ? String(s.get("voice").autoSpeak) : null,
  "voice.ttsRate": (s) => s.get("voice")?.ttsRate != null ? String(s.get("voice").ttsRate) : null,
};

/** `useReasoningEffort.ts:3-9` → `Effort` Jarod : « auto » = "" (laisser le modèle décider) ; `minimal` sans équivalent. */
const SANK_EFFORTS = new Map<string, Effort>([
  ["auto", ""],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
]);

/** Écritures des mêmes clés ; une valeur sans équivalent lève. */
const CONFIG_WRITERS: Record<string, (s: Settings, value: string) => void> = {
  "agent.reasoning_effort": (s, value) => {
    const effort = SANK_EFFORTS.get(value);
    if (effort === undefined) throw new Error(`[oneai] effort de raisonnement « ${value} » sans équivalent Jarod`);
    s.set("effort", effort);
  },
  // Voice settings (SPECS-P5-VOICE-PANE.md)
  "voice.autoSpeak": (s, value) => {
    const v = s.get("voice") ?? { sttProvider: "openai", sttModel: "whisper-1", autoSpeak: false, ttsVoice: "", ttsRate: 1 };
    v.autoSpeak = value === "true";
    s.set("voice", v);
  },
  "voice.ttsRate": (s, value) => {
    const v = s.get("voice") ?? { sttProvider: "openai", sttModel: "whisper-1", autoSpeak: false, ttsVoice: "", ttsRate: 1 };
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error(`[oneai] ttsRate hors bornes [0.25, 4]`);
    v.ttsRate = rate;
    s.set("voice", v);
  },
};

/** `validation.ts:28-47`. */
export interface ChatReadiness {
  ok: boolean;
  code?: "NO_ACTIVE_MODEL" | "NO_PROVIDER" | "NO_BASE_URL" | "MISSING_API_KEY" | "GATEWAY_DOWN";
  message?: string;
  fixLocation?: "providers" | "models" | "gateway" | "setup";
  expectedEnvKey?: string;
}

/** `config-health.ts:57-76`. */
export interface ConfigHealthIssue {
  code: "MODEL_KEY_MISSING" | "NON_ASCII_CREDENTIAL";
  severity: "error" | "warning" | "info";
  message: string;
  detail?: string;
  locations: string[];
  autoFixable: boolean;
  fixDescription?: string;
  fixLocation?: "providers" | "models" | ".env" | "config.yaml" | "setup";
  context?: Record<string, string>;
}

export interface ConfigHealthReport {
  ranAt: number;
  profile: string;
  issues: ConfigHealthIssue[];
  summary: { errors: number; warnings: number; infos: number };
}

export function createConfigHandlers(ctx: HandlerContext) {
  const k = () => ctx.kernel();
  const settings = () => k().agent.settings;

  /** `config.ts:708-734` sur les réglages Jarod ; fournisseur inconnu du catalogue → URL vide. */
  const modelConfig = () => {
    const provider = settings().get("activeProvider");
    let baseUrl = "";
    try {
      baseUrl = k().agent.providers.def(provider).baseUrl;
    } catch {
      /* fournisseur hors catalogue */
    }
    return { provider, model: settings().get("activeModel"), baseUrl };
  };

  /** Le fournisseur actif, tel que `ProviderRouter.list()` le voit (clé / local), ou `undefined` s'il est inconnu. */
  const activeInfo = () => {
    const id = settings().get("activeProvider");
    return k().agent.providers.list().find((p) => p.id === id);
  };

  /** `validation.ts:84-157` : mêmes étapes, même règle « dans le doute, laisser envoyer ». */
  const readiness = (): ChatReadiness => {
    try {
      const mc = modelConfig();
      const provider = mc.provider.trim();
      if (!provider) return { ok: true };
      if (!mc.model.trim()) {
        return { ok: false, code: "NO_ACTIVE_MODEL", message: "No model selected. Pick one in Models or the Chat picker.", fixLocation: "models" };
      }
      const info = activeInfo();
      // Combinaison inconnue : on ne sait pas quelle clé vérifier → envoi permis (validation.ts:111-116).
      if (!info) return { ok: true };
      if (info.configured || isLocalBaseUrl(mc.baseUrl)) return { ok: true };
      return { ok: false, code: "MISSING_API_KEY", message: `Missing API key for ${provider}. Set it in Providers.`, fixLocation: "providers" };
    } catch {
      return { ok: true };
    }
  };

  /** `config-health.ts:270-322` : fournisseur actif sans clé (et pas local). */
  const checkActiveModelKeyPresence = (): ConfigHealthIssue[] => {
    const mc = modelConfig();
    if (!mc.provider || !mc.model) return [];
    if (isLocalBaseUrl(mc.baseUrl)) return [];
    const info = activeInfo();
    if (!info || info.configured) return [];
    return [
      {
        code: "MODEL_KEY_MISSING",
        severity: "warning",
        message: `Active model uses ${mc.provider} but no API key is stored for it.`,
        detail:
          "Chat will fail with an upstream auth error until the key is configured. Add it under Providers, or switch to a model whose credentials are already set.",
        locations: [],
        autoFixable: false,
        fixLocation: "providers",
        context: { provider: mc.provider },
      },
    ];
  };

  /** `config-health.ts:388-424` sur les clés du coffre (fournisseurs) ; pas de correction automatique ici. */
  const checkNonAsciiCredentials = (): ConfigHealthIssue[] => {
    const offenders: string[] = [];
    for (const p of k().agent.providers.list()) {
      if (k().agent.providers.apiKeys(p.id).some((key) => /[^\x20-\x7e]/.test(key))) offenders.push(p.id);
    }
    if (offenders.length === 0) return [];
    return [
      {
        code: "NON_ASCII_CREDENTIAL",
        severity: "info",
        message: `Non-ASCII characters detected in the API key(s) of: ${offenders.join(", ")}.`,
        detail: "Common cause: a smart-quote or trailing newline from a paste. Re-enter the key under Providers.",
        locations: [],
        autoFixable: false,
        fixLocation: "providers",
        context: { providers: offenders.join(",") },
      },
    ];
  };

  // config-health.ts:89-120 : chaque contrôle isolé, un contrôle qui lève ne casse pas le bilan.
  const healthReport = (): ConfigHealthReport => {
    const report: ConfigHealthReport = { ranAt: Date.now(), profile: k().profile, issues: [], summary: { errors: 0, warnings: 0, infos: 0 } };
    for (const check of [checkActiveModelKeyPresence, checkNonAsciiCredentials]) {
      try {
        for (const issue of check()) {
          report.issues.push(issue);
          if (issue.severity === "error") report.summary.errors++;
          else if (issue.severity === "warning") report.summary.warnings++;
          else report.summary.infos++;
        }
      } catch (err) {
        console.warn("[config-health] check threw:", err);
      }
    }
    return report;
  };

  return {
    // locale.ts:32-41 : la valeur enregistrée si elle est connue, sinon la langue par défaut de SANK-UI.
    "get-locale": (): AppLocale => {
      const saved = readDesktopConfig(desktopConfigFile(k()))[DESKTOP_LOCALE_KEY];
      return isAppLocale(saved) ? saved : DEFAULT_ACTIVE_LOCALE;
    },
    // Écart : une langue hors `APP_LOCALES` est refusée (SANK-UI la passait à i18next sans contrôle).
    "set-locale": (locale: unknown): AppLocale => {
      if (!isAppLocale(locale)) throw new Error(`[oneai] langue d'interface inconnue : ${String(locale)}`);
      const file = desktopConfigFile(k());
      writeDesktopConfig(file, { ...readDesktopConfig(file), [DESKTOP_LOCALE_KEY]: locale });
      return locale;
    },
    // hermes.ts:147-150 : connexion toujours locale (install.ts).
    "is-remote-only-mode": () => false,
    "get-config": (key: unknown, profile?: unknown): string | null => {
      assertProfile(ctx, profile);
      if (typeof key !== "string" || !Object.hasOwn(CONFIG_KEYS, key)) return null;
      return CONFIG_KEYS[key]!(settings());
    },
    // register.ts:1057-1068 (`setConfigValue`, puis true).
    "set-config": (key: unknown, value: unknown, profile?: unknown): true => {
      assertProfile(ctx, profile);
      if (typeof key !== "string" || typeof value !== "string") throw new Error("[oneai] set-config : clé et valeur texte attendues");
      if (!Object.hasOwn(CONFIG_WRITERS, key)) throw new Error(`[oneai] clé de configuration « ${key} » non portée`);
      CONFIG_WRITERS[key]!(settings(), value);
      return true;
    },
    "get-model-config": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return modelConfig();
    },
    // register.ts:1101-1200 (chemin local : `setModelConfig`, puis true).
    "set-model-config": (provider: unknown, model: unknown, baseUrl: unknown, profile?: unknown): true => {
      assertProfile(ctx, profile);
      if (typeof provider !== "string" || typeof model !== "string") throw new Error("[oneai] set-model-config : fournisseur et modèle texte attendus");
      if (!k().agent.providers.list().some((p) => p.id === provider)) throw new Error(`[oneai] fournisseur inconnu de Jarod : ${provider}`);
      const patch: Parameters<Settings["patch"]>[0] = { activeProvider: provider, activeModel: model };
      const url = (typeof baseUrl === "string" ? baseUrl : "").trim().replace(/\/+$/, "");
      if (provider === "custom" && url) {
        if (!/^https?:\/\//i.test(url)) throw new Error(`[oneai] URL de fournisseur invalide : ${url}`);
        const overrides = { ...settings().get("providerOverrides") };
        overrides.custom = { ...overrides.custom, baseUrl: url };
        patch.providerOverrides = overrides;
      }
      settings().patch(patch);
      // Hotswap : un modèle local choisi dans le sélecteur se charge TOUT DE SUITE (sans attendre le premier message) ; le tour suivant attend
      // ce chargement (préparation du fournisseur). Un échec est dit par ce tour, pas ici.
      // `prepare` ne fait rien quand le hotswap est éteint.
      const models = k().localEngine?.models;
      if (models && (provider === "llamacpp" || provider === "lmstudio")) {
        models.prepare(provider, model).catch((e: unknown) => console.warn(`[local-models] chargement de ${provider} · ${model} : ${(e as Error).message}`));
      }
      return true;
    },
    "validate-chat-readiness": (profile?: unknown): ChatReadiness => {
      assertProfile(ctx, profile);
      return readiness();
    },
    "get-config-health": (profile?: unknown): ConfigHealthReport => {
      assertProfile(ctx, profile);
      return healthReport();
    },
    // register.ts:997-999 : même bilan, recalculé (Jarod ne garde pas de bilan en cache).
    "rerun-config-health": (profile?: unknown): ConfigHealthReport => {
      assertProfile(ctx, profile);
      return healthReport();
    },
    // register.ts:1001-1011 : aucun contrôle Jarod n'est `autoFixable` — rien n'est modifié, la raison est rendue.
    "autofix-config-issue": (code: unknown, profile?: unknown) => {
      assertProfile(ctx, profile);
      return { ok: false, message: `Pas de correction automatique pour ${String(code)} : corrige-la depuis l'écran indiqué.` };
    },
    // register.ts:1013-1015 : journal des corrections automatiques — aucune n'a jamais eu lieu.
    "get-config-fix-log": (): never[] => [],
    /**
     * register.ts:1207-1260 : modèles « auxiliaires » par tâche (compression, vision, titres…) de `config.yaml`.
     * Jarod n'en a pas : le modèle actif sert toutes les tâches, c.-à-d. l'état « auto » de SANK-UI. Lecture = []
     * (réponse SANK-UI sans config auxiliaire) ; revenir à « auto » = l'état servi (true) ; choisir un modèle par
     * tâche LÈVE (écriture sans équivalent, règle de `set-config`).
     */
    "get-auxiliary-config": (profile?: unknown): never[] => {
      assertProfile(ctx, profile);
      return [];
    },
    "set-auxiliary-task": (task: unknown, _cfg: unknown, profile?: unknown): never => {
      assertProfile(ctx, profile);
      throw new Error(`[oneai] modèle auxiliaire « ${String(task)} » non porté : Jarod utilise le modèle actif pour toutes les tâches`);
    },
    "reset-auxiliary-config": (profile?: unknown): true => {
      assertProfile(ctx, profile);
      return true;
    },
    /**
     * register.ts:747-760 (`hermes doctor`, texte affiché dans Réglages › Diagnostic). Jarod n'a pas de CLI Hermes :
     * rapport du kernel SERVI — version, profil, modèle actif et présence de sa clé (jamais la clé), skills, bilan
     * de configuration. Aucun secret ni chemin personnel.
     */
    "run-hermes-doctor": (): string => {
      const mc = modelConfig();
      const info = activeInfo();
      const key = !mc.provider ? "aucun fournisseur actif" : isLocalBaseUrl(mc.baseUrl) ? "local (pas de clé)" : info?.configured ? "clé enregistrée" : "clé ABSENTE";
      const skills = k().agent.skills;
      const report = healthReport();
      const lines = [
        `Jarod-One ${ctx.shell.appVersion()} — diagnostic du profil « ${k().profile} »`,
        `Kernel : démarré`,
        `Modèle actif : ${mc.provider || "—"} / ${mc.model || "—"} (${key})`,
        `Skills : ${skills.list().length} chargées, ${skills.collisions().length} collision(s) d'identifiant`,
        `Bilan de configuration : ${report.summary.errors} erreur(s), ${report.summary.warnings} avertissement(s), ${report.summary.infos} info(s)`,
        ...report.issues.map((i) => `  - [${i.severity}] ${i.message}`),
      ];
      return `${lines.join("\n")}\n`;
    },
    // dashboard.ts:49-56 (`DashboardStatus`) et :607-610 (plateforme sans tableau de bord).
    "start-dashboard": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return { supported: false, running: false, error: "Jarod-One n'a pas de tableau de bord Hermes : le chat passe par l'IPC." };
    },
  };
}
