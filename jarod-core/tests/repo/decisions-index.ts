/** Index de DECISIONS.md : une ligne par décision (`- AAAA-MM-JJ · …`), groupée par mois, avec le numéro de ligne. Rendu par `pnpm decisions:index`. */
export interface DecisionEntry {
  /** Numéro de ligne dans DECISIONS.md (1-based). */
  line: number;
  date: string;
  title: string;
}

const ENTRY = /^- (\d{4}-\d{2}-\d{2}) · (.*)$/;
const MAX = 160;

function shorten(text: string): string {
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function titleOf(rest: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(rest);
  return shorten((bold ? bold[1]! : rest).trim());
}

export function parseDecisions(text: string): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = ENTRY.exec(l);
    if (m) out.push({ line: i + 1, date: m[1]!, title: titleOf(m[2]!) });
  });
  return out;
}

export function renderIndex(entries: DecisionEntry[]): string {
  const months = new Map<string, DecisionEntry[]>();
  for (const e of entries) {
    const k = e.date.slice(0, 7);
    months.set(k, [...(months.get(k) ?? []), e]);
  }
  const lines = [
    "# Index de DECISIONS.md",
    "",
    `Généré par \`pnpm decisions:index\` — ${entries.length} décisions. Le texte complet reste dans DECISIONS.md (chronologique, une entrée par ligne) ; cet index n'en est qu'une table.`,
    "",
  ];
  for (const k of [...months.keys()].sort().reverse()) {
    const list = months.get(k)!;
    lines.push(`## ${k} (${list.length})`, "");
    for (const e of list) lines.push(`- [${e.date}](DECISIONS.md#L${e.line}) · ${e.title}`);
    lines.push("");
  }
  return lines.join("\n");
}
