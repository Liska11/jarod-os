/**
 * Jarod-cordis (Q18, décision utilisateur 2026-09-28) : `refine` — mises à jour de la mémoire justifiées par
 * une preuve, avec instantané et retour arrière. Portage de SANK-AI `src/core/runtime/plugins/refine/index.js`
 * (MIT © SankAi contributors ; pattern « Continual Harness » de Prime Agent).
 *
 * Écarts : la mémoire de Jarod est faite d'ENTRÉES (table `memories`), pas de pages markdown — les opérations
 * sont ajout / modification / suppression d'un souvenir ; l'historique est gardé dans le coffre du profil
 * (secret `refine:history`, chiffré, dans la base) au lieu d'un JSONL en clair : un fichier à côté de la base
 * chiffrée exposerait le contenu des souvenirs ; il est emporté par la sauvegarde avec la base, jamais transmis
 * au renderer. Borné à `REFINE_HISTORY_MAX` entrées : au-delà, la plus ancienne est évincée (le souvenir reste,
 * il n'est simplement plus annulable ; les index se décalent) — jamais de rejet. Invariant gardé : la persona (SOUL.md, réglage `persona`)
 * et le prompt système ne sont JAMAIS touchés — seul `memories` l'est.
 */
import type { Memory, MemoryType } from "@jarod/contracts";
import type { MemoryService } from "@jarod/plugin-memory";
import type { SettingsService } from "@jarod/plugin-storage";
import type { ToolDef } from "@jarod/plugin-tools";

export const REFINE_HISTORY_KEY = "refine:history";
export const REFINE_HISTORY_MAX = 200;

type Snapshot = Pick<Memory, "id" | "type" | "content"> | null;

export interface RefineEntry {
  at: number;
  op: "add" | "update" | "delete";
  id: string;
  evidence: string;
  before: Snapshot;
  after: Snapshot;
  rolledBackAt?: number;
}

const TYPES: MemoryType[] = ["fact", "preference", "context"];
const snap = (m: Memory | undefined): Snapshot => (m ? { id: m.id, type: m.type, content: m.content } : null);

export class RefineService {
  constructor(
    private readonly memory: MemoryService,
    private readonly settings: SettingsService,
    private readonly now: () => number = Date.now,
  ) {}

  history(): RefineEntry[] {
    const raw = this.settings.getSecret(REFINE_HISTORY_KEY);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? (v as RefineEntry[]) : [];
    } catch {
      return [];
    }
  }

  private save(entries: RefineEntry[]): void {
    this.settings.setSecret(REFINE_HISTORY_KEY, JSON.stringify(entries.slice(-REFINE_HISTORY_MAX)));
  }

  apply(o: { op: string; id?: string; content?: string; type?: string; evidence: string }): RefineEntry | null {
    const evidence = o.evidence.trim();
    if (!evidence) throw new Error("Preuve obligatoire (evidence) : ce qui justifie la mise à jour.");
    const type = TYPES.includes(o.type as MemoryType) ? (o.type as MemoryType) : undefined;
    let entry: RefineEntry;
    if (o.op === "add") {
      const content = (o.content ?? "").trim();
      if (!content) throw new Error("Contenu vide.");
      const known = this.memory.list().find((m) => m.content === content);
      // `MemoryService.add` rend le souvenir existant s'il est identique : rien n'a changé, rien à annuler.
      if (known) return null;
      const m = this.memory.add(content, type ?? "fact");
      entry = { at: this.now(), op: "add", id: m.id, evidence, before: null, after: snap(m) };
    } else if (o.op === "update" || o.op === "delete") {
      const before = o.id ? this.memory.get(o.id) : undefined;
      if (!before) throw new Error(`Souvenir introuvable : ${o.id ?? "(id absent)"}`);
      if (o.op === "update") {
        const content = (o.content ?? "").trim();
        if (!content) throw new Error("Contenu vide.");
        this.memory.update(before.id, content, type);
        entry = { at: this.now(), op: "update", id: before.id, evidence, before: snap(before), after: snap(this.memory.get(before.id)) };
      } else {
        this.memory.delete(before.id);
        entry = { at: this.now(), op: "delete", id: before.id, evidence, before: snap(before), after: null };
      }
    } else {
      throw new Error(`Opération inconnue : ${o.op} (add|update|delete)`);
    }
    this.save([...this.history(), entry]);
    return entry;
  }

  /** Annule une entrée (la dernière non annulée par défaut). Un ajout annulé = souvenir retiré. */
  rollback(index?: number): { index: number; entry: RefineEntry; note: string } {
    const all = this.history();
    const i = index ?? all.findLastIndex((e) => !e.rolledBackAt);
    const e = all[i];
    if (!e) throw new Error(all.length ? `Index hors bornes : ${i}` : "Aucun historique refine.");
    if (e.rolledBackAt) throw new Error(`Entrée ${i} déjà annulée.`);
    let note: string;
    if (e.op === "add") {
      this.memory.delete(e.id);
      note = "souvenir ajouté retiré";
    } else if (this.memory.get(e.id)) {
      this.memory.update(e.id, e.before!.content, e.before!.type);
      note = "souvenir remis dans son état d'avant";
    } else {
      const m = this.memory.add(e.before!.content, e.before!.type);
      note = `souvenir recréé (nouvel id ${m.id})`;
    }
    e.rolledBackAt = this.now();
    this.save(all);
    return { index: i, entry: e, note };
  }
}

export function refineTools(refine: RefineService): ToolDef[] {
  return [
    {
      name: "refine",
      description:
        "Met à jour la mémoire durable à partir d'une PREUVE (résultat de test, correction de l'utilisateur, fait vérifié) : ajoute, modifie (id) ou supprime (id) un souvenir. Chaque changement est journalisé avec un instantané et peut être annulé (refine_rollback). Ne touche jamais la persona ni le prompt système.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "delete"] },
          id: { type: "string", description: "Souvenir visé (update, delete) — voir memory_search" },
          content: { type: "string", description: "Nouveau contenu (add, update)" },
          type: { type: "string", enum: TYPES },
          evidence: { type: "string", description: "La preuve qui justifie ce changement" },
        },
        required: ["op", "evidence"],
      },
      dangerous: true,
      source: "builtin",
      async run(args) {
        const e = refine.apply({
          op: String(args.op ?? ""),
          id: typeof args.id === "string" ? args.id : undefined,
          content: typeof args.content === "string" ? args.content : undefined,
          type: typeof args.type === "string" ? args.type : undefined,
          evidence: String(args.evidence ?? ""),
        });
        if (!e) return "Déjà en mémoire à l'identique : rien à changer.";
        return `ok : refine ${e.op} (${e.id}) appliqué et journalisé (entrée ${refine.history().length - 1}) ; annulable par refine_rollback.`;
      },
    },
    {
      name: "refine_history",
      description: "Historique des mises à jour refine de la mémoire (opération, souvenir, preuve, annulée ou non).",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      async run() {
        const h = refine.history();
        if (!h.length) return "Aucun historique refine.";
        return JSON.stringify(
          h.map((e, i) => ({ i, at: new Date(e.at).toISOString(), op: e.op, id: e.id, evidence: e.evidence.slice(0, 120), rolledBack: !!e.rolledBackAt })),
        );
      },
    },
    {
      name: "refine_rollback",
      description: "Annule une mise à jour refine (la dernière non annulée par défaut, ou `index` de refine_history).",
      parameters: { type: "object", properties: { index: { type: "integer" } } },
      dangerous: true,
      source: "builtin",
      async run(args) {
        const r = refine.rollback(typeof args.index === "number" ? args.index : undefined);
        return `ok : entrée ${r.index} (${r.entry.op} ${r.entry.id}) annulée — ${r.note}.`;
      },
    },
  ];
}
