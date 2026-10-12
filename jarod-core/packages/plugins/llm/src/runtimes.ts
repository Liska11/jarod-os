// Portage de packages/core/src/services/runtimes.ts (rév. 2e180305).
export interface LocalRuntime {
  id: string;
  label: string;
  port: number;
  baseUrl: string;
  /** Vrai dès qu'il y a une réponse — même un refus. Voir plus bas pourquoi. */
  alive: boolean;
}

/** Les serveurs locaux que la machine peut faire tourner, et le port par défaut de chacun. */
export const KNOWN_RUNTIMES: { id: string; label: string; port: number }[] = [
  { id: "llamacpp", label: "llama.cpp / llama-server", port: 8080 },
  { id: "lmstudio", label: "LM Studio", port: 1234 },
  { id: "ollama", label: "Ollama", port: 11434 },
  { id: "vllm", label: "vLLM", port: 8000 },
  { id: "sglang", label: "SGLang", port: 30000 },
  { id: "llamafile", label: "llamafile", port: 8081 },
  { id: "openvino", label: "OpenVINO (NPU / iGPU)", port: 9000 },
];

/**
 * Finds the local model servers actually listening, instead of assuming the ports written in the
 * catalogue.
 *
 * A runtime counts as present as soon as it answers anything — including 401. A server that guards
 * itself is still a server: refusing a request is the strongest possible sign that someone is
 * listening, and a probe that demands a 200 would report every locked door as a missing house.
 *
 * The probe never guesses a model list: it says which ports answer, and lets the caller ask the rest.
 */
export class RuntimeProbeService {
  constructor(
    private readonly d: {
      /** Injectable: a test can hand it a server it started itself. */
      probe?: (url: string, timeoutMs: number) => Promise<boolean>;
      /** Injectable: the port list to sweep. Defaults to the known runtimes. */
      ports?: () => { id: string; label: string; port: number }[];
      timeoutMs?: number;
    } = {},
  ) {}

  async scan(): Promise<LocalRuntime[]> {
    const list = this.d.ports?.() ?? KNOWN_RUNTIMES;
    const timeout = this.d.timeoutMs ?? 600;
    const doProbe = this.d.probe ?? defaultProbe;
    return await Promise.all(
      list.map(async (entry) => {
        const baseUrl = `http://127.0.0.1:${entry.port}`;
        const alive = await doProbe(`${baseUrl}/v1/models`, timeout).catch(() => false);
        return { id: entry.id, label: entry.label, port: entry.port, baseUrl, alive };
      }),
    );
  }

  /** Seulement ceux qui répondent, prêts à être proposés comme fournisseur. */
  async reachable(): Promise<LocalRuntime[]> {
    return (await this.scan()).filter((entry) => entry.alive);
  }
}

/** Une réponse, n'importe laquelle, suffit : le doute n'existe pas sur un port muet. */
async function defaultProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
