// Portage de packages/core/src/services/local.ts (rév. 2e180305).
import { execFile } from "node:child_process";
import { cpus, platform, totalmem } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Gpu {
  name: string;
  /** Dedicated memory in GB, when it can be read reliably. */
  vramGb: number | null;
  /**
   * Ce que le pilote ne dit pas et que sapphire compte : une mémoire partagée se budgète autrement
   * qu'une VRAM dédiée, et un NPU ne fait pas tourner un LLM de chat.
   */
  kind?: AcceleratorKind;
  backend?: string;
  sharedMemory?: boolean;
}

export type AcceleratorKind = "dgpu" | "igpu" | "npu" | "cpu";

/**
 * Nomme le matériel d'après ce que le pilote déclare. Fonction pure : aucun accès machine, donc
 * chaque cas se prouve, et le jour où un pilote change de nom, un seul endroit change.
 *
 * « Arc(TM) Graphics » sans lettre de modèle est un iGPU (celui des portables) ; « Arc A770 » ou
 * « Arc B580 » sont des cartes dédiées. Confondre les deux fait recommander le mauvais modèle.
 */
export function classifyAccelerator(
  name: string,
  _reportedBytes: number | null = null,
): { kind: AcceleratorKind; backend: string; sharedMemory: boolean } {
  // Les pilotes décorent leurs noms : « Intel(R) Arc(TM) A770 ». Retirer ces marques une fois évite
  // des motifs qui essaient de les enjamber — « (TM) » contient des lettres, donc aucune classe de
  // non-lettres ne le franchit, et la carte dédiée finit classée en iGPU.
  const lower = name
    .toLowerCase()
    .replace(/\((tm|r|c)\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/(npu|neural|ai boost|vpu|xdna|ryzen ai)/.test(lower)) {
    return { kind: "npu", backend: /ryzen ai|xdna/.test(lower) ? "qnn" : "openvino", sharedMemory: true };
  }
  if (/nvidia|geforce|quadro|tesla/.test(lower)) return { kind: "dgpu", backend: "cuda", sharedMemory: false };
  if (/arc\s*(a|b)\d|arc pro|radeon (rx|pro|vii)/.test(lower)) {
    return { kind: "dgpu", backend: /arc/.test(lower) ? "vulkan" : "rocm", sharedMemory: false };
  }
  // « Intel(R) Graphics » tout court : c'est ainsi que le pilote annonce l'iGPU Arc sur cette
  // machine, et aucune règle ne le couvrait — il finissait classé « cpu ». Un contrôleur Intel qui
  // n'est pas un modèle Arc dédié est un iGPU.
  if (/intel/.test(lower) && /(graphics|arc|iris|uhd)/.test(lower)) {
    return { kind: "igpu", backend: "sycl", sharedMemory: true };
  }
  if (/radeon|vega/.test(lower)) return { kind: "igpu", backend: "vulkan", sharedMemory: true };
  // Un contrôleur qu'on ne sait pas nommer : on le dit, plutôt que de le ranger de force.
  return { kind: "cpu", backend: "cpu", sharedMemory: true };
}

/**
 * L'inventaire enrichi. La sonde existante n'est pas réécrite — elle est prolongée : une seule
 * source de vérité, et le nom exporté reste le même pour tous ses appelants.
 */
export async function detectHardware(): Promise<Hardware> {
  const hw = await probeHardware();
  return { ...hw, gpus: hw.gpus.map((gpu) => ({ ...gpu, ...classifyAccelerator(gpu.name) })) };
}

export interface Hardware {
  platform: string;
  cpu: string;
  cores: number;
  ramGb: number;
  gpus: Gpu[];
  appleSilicon: boolean;
}

const round = (n: number) => Math.round(n * 10) / 10;

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

/** Best-effort hardware profile used to recommend local models. */
async function probeHardware(): Promise<Hardware> {
  const cpuList = cpus();
  const hw: Hardware = {
    platform: platform(),
    cpu: cpuList[0]?.model.trim() ?? "?",
    cores: cpuList.length,
    ramGb: round(totalmem() / 1024 ** 3),
    gpus: [],
    appleSilicon: platform() === "darwin" && /Apple/i.test(cpuList[0]?.model ?? ""),
  };

  // NVIDIA reports exact VRAM on every OS.
  const smi = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (smi) {
    for (const line of smi.trim().split(/\r?\n/)) {
      const [name, mem] = line.split(",").map((x) => x.trim());
      if (name) hw.gpus.push({ name, vramGb: mem ? round(Number(mem) / 1024) : null });
    }
    return hw;
  }
  if (hw.platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
    ]);
    if (out) {
      try {
        const parsed = JSON.parse(out) as
          | { Name: string; AdapterRAM: number | null }
          | { Name: string; AdapterRAM: number | null }[];
        for (const g of Array.isArray(parsed) ? parsed : [parsed]) {
          // AdapterRAM is a 32-bit field: values at the 4 GB cap are unreliable.
          const gb = g.AdapterRAM ? g.AdapterRAM / 1024 ** 3 : 0;
          hw.gpus.push({ name: g.Name, vramGb: gb > 0.5 && gb < 3.99 ? round(gb) : null });
        }
      } catch {
        /* ignore */
      }
    }
  } else if (hw.platform === "darwin") {
    const out = await run("system_profiler", ["SPDisplaysDataType", "-json"]);
    try {
      const items =
        (JSON.parse(out ?? "{}") as { SPDisplaysDataType?: { sppci_model?: string }[] }).SPDisplaysDataType ?? [];
      for (const g of items) hw.gpus.push({ name: g.sppci_model ?? "GPU", vramGb: hw.appleSilicon ? null : null });
    } catch {
      /* ignore */
    }
  }
  return hw;
}

/**
 * Libellé du repli `taille × 1,2` (décision du 2026-10-03) : il ne regarde que le POIDS du fichier — ni le contexte, ni les couches d'attention, ni le cache KV.
 * `LOCAL_CATALOG` n'a pas d'en-tête GGUF à lire : l'estimation par en-tête (`gguf-fit.ts`) ne s'y branche pas.
 */
export const WEIGHTS_ONLY_FIT_LABEL = "poids seulement, pas un fit KV";

export interface ModelSuggestion {
  name: string;
  label: string;
  sizeGb: number;
  description: string;
  fits: "good" | "tight" | "too-big";
  /** Sur quoi repose `fits` : le poids seul (`taille × 1,2`), jamais un calcul de cache KV. */
  fitBasis: typeof WEIGHTS_ONLY_FIT_LABEL;
}

/** Popular Ollama models, from smallest to largest (download size, Q4 quantization). */
export const LOCAL_CATALOG: Omit<ModelSuggestion, "fits" | "fitBasis">[] = [
  { name: "llama3.2:3b", label: "Llama 3.2 3B", sizeGb: 2.0, description: "Très léger, rapide même sans GPU." },
  {
    name: "qwen2.5:7b",
    label: "Qwen 2.5 7B",
    sizeGb: 4.7,
    description: "Polyvalent, bon en français et en code, gère les outils.",
  },
  { name: "llama3.1:8b", label: "Llama 3.1 8B", sizeGb: 4.9, description: "Généraliste solide, appels d'outils." },
  { name: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", sizeGb: 4.7, description: "Spécialisé programmation." },
  {
    name: "gemma3:12b",
    label: "Gemma 3 12B",
    sizeGb: 8.1,
    description: "Multimodal (images), très bon rapport qualité/taille.",
  },
  { name: "qwen2.5:14b", label: "Qwen 2.5 14B", sizeGb: 9.0, description: "Plus de raisonnement, outils fiables." },
  { name: "mistral-small:24b", label: "Mistral Small 24B", sizeGb: 14, description: "Excellent en français, outils." },
  { name: "qwen2.5:32b", label: "Qwen 2.5 32B", sizeGb: 20, description: "Proche des modèles cloud moyens." },
  {
    name: "llama3.3:70b",
    label: "Llama 3.3 70B",
    sizeGb: 43,
    description: "Haut de gamme, demande beaucoup de mémoire.",
  },
];

/**
 * Memory the model can realistically use: VRAM on discrete GPUs, most of unified memory on
 * Apple Silicon, otherwise a share of system RAM (CPU inference).
 */
export function memoryBudgetGb(hw: Hardware): number {
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramGb ?? 0));
  if (hw.appleSilicon) return hw.ramGb * 0.7;
  if (vram >= 4) return vram;
  return hw.ramGb * 0.5;
}

/** Repli « poids seulement » : `fits` ne dit RIEN du cache KV ni du contexte (voir `WEIGHTS_ONLY_FIT_LABEL`). */
export function recommendModels(hw: Hardware): ModelSuggestion[] {
  const budget = memoryBudgetGb(hw);
  return LOCAL_CATALOG.map((m) => {
    const need = m.sizeGb * 1.2; // weights + KV cache headroom
    return { ...m, fits: need <= budget ? "good" : need <= budget * 1.4 ? "tight" : "too-big", fitBasis: WEIGHTS_ONLY_FIT_LABEL };
  });
}

export interface OllamaModel {
  name: string;
  sizeGb: number;
  modifiedAt: string;
  family?: string;
  parameters?: string;
}

/** Minimal client for the native Ollama API (list, pull with progress, delete). */
export class OllamaClient {
  constructor(readonly host: string) {}

  static fromBaseUrl(baseUrl: string): OllamaClient {
    return new OllamaClient(baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""));
  }

  async version(): Promise<string | null> {
    try {
      const r = await fetch(`${this.host}/api/version`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? ((await r.json()) as { version: string }).version : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<OllamaModel[]> {
    const r = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Ollama : HTTP ${r.status}`);
    const body = (await r.json()) as {
      models?: {
        name: string;
        size: number;
        modified_at: string;
        details?: { family?: string; parameter_size?: string };
      }[];
    };
    return (body.models ?? []).map((m) => ({
      name: m.name,
      sizeGb: round(m.size / 1024 ** 3),
      modifiedAt: m.modified_at,
      ...(m.details?.family ? { family: m.details.family } : {}),
      ...(m.details?.parameter_size ? { parameters: m.details.parameter_size } : {}),
    }));
  }

  async pull(
    name: string,
    onProgress: (p: { status: string; percent: number | null }) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const r = await fetch(`${this.host}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, stream: true }),
      ...(signal ? { signal } : {}),
    });
    if (!r.ok || !r.body) throw new Error(`Téléchargement impossible (HTTP ${r.status})`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
        if (ev.error) throw new Error(ev.error);
        onProgress({
          status: ev.status ?? "",
          percent: ev.total && ev.completed !== undefined ? Math.round((ev.completed / ev.total) * 100) : null,
        });
      }
    }
  }

  async delete(name: string): Promise<void> {
    const r = await fetch(`${this.host}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
    if (!r.ok) throw new Error(`Suppression impossible (HTTP ${r.status})`);
  }
}
