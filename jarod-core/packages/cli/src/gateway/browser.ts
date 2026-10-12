// Le navigateur de l'agent (outils `browser_*`) pour Jarod-OS : le noyau n'a pas de fenêtre, il demande chaque opération à la fenêtre de Jarod-OS (`jarod.shell`, geste
// « browser »), dont le processus principal tient la fenêtre isolée (apps/desktop/electron/agent-browser). Ce module est le `BrowserPort` que `plugin-tools` attend.
// Sans fenêtre connectée l'opération échoue en le disant : les outils existent, mais ne naviguent pas dans le vide.
import type { BrowserElement, BrowserPort, BrowserSnapshot } from "@jarod/contracts";
import type { ShellLink } from "./bridge-shell.js";

export type RemoteBrowser = BrowserPort & { forget(): Promise<void> };

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Une réponse de la fenêtre est des données, pas des ordres : on la réduit à la forme d'un instantané, bornée. */
export function toSnapshot(raw: unknown): BrowserSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const elements: BrowserElement[] = Array.isArray(r.elements)
    ? r.elements.slice(0, 200).map((e, i) => {
        const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        return { index: typeof o.index === "number" ? o.index : i, tag: text(o.tag, 20), type: text(o.type, 20), label: text(o.label, 120), href: text(o.href, 500) };
      })
    : [];
  return { url: text(r.url, 2000), title: text(r.title, 300), text: text(r.text, 60_000), elements };
}

export function createRemoteBrowser(o: { link: Pick<ShellLink, "ask">; visible: () => boolean; persistent: () => boolean }): RemoteBrowser {
  const call = async (op: string, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) throw new Error("annulé");
    const asking = o.link.ask("browser", { op, args, visible: o.visible(), persistent: o.persistent() });
    const answer = await (signal
      ? Promise.race([
          asking,
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("annulé")), { once: true })),
        ])
      : asking);
    if (answer === null || typeof answer !== "object") throw new Error("navigateur indisponible : aucune fenêtre Jarod-OS ne l'a ouvert");
    const a = answer as { ok?: unknown; snapshot?: unknown; error?: unknown };
    if (a.ok !== true) throw new Error(text(a.error, 500) || "le navigateur a refusé l'opération");
    return a.snapshot;
  };
  const snap = async (op: string, args: unknown[], signal?: AbortSignal): Promise<BrowserSnapshot> => toSnapshot(await call(op, args, signal));
  return {
    open: (url, signal) => snap("open", [url], signal),
    read: (signal) => snap("read", [], signal),
    click: (index, signal) => snap("click", [index], signal),
    type: (index, value, submit, signal) => snap("type", [index, value, submit], signal),
    press: (key, signal) => snap("press", [key], signal),
    scroll: (direction, signal) => snap("scroll", [direction], signal),
    back: (signal) => snap("back", [], signal),
    wait: (seconds, expected, signal) => snap("wait", expected === undefined ? [seconds] : [seconds, expected], signal),
    reveal: async () => void (await call("reveal", [])),
    close: async () => void (await call("close", [])),
    forget: async () => void (await call("forget", [])),
  };
}
