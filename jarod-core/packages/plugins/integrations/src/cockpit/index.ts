/**
 * Cockpit : le registre vivant des capacités. Branché par le plugin à partir des services DÉJÀ chargés (outils, skills,
 * permissions, réglages), lus par leur forme pour ne pas dépendre de leurs paquets. Un service absent vaut « rien de déclaré ».
 */
import { nodeProbeHost, type ProbeHost } from "./probe.js";
import { CapabilityService } from "./service.js";

export * from "./catalog.js";
export { firstVersion, nodeProbeHost, type ProbeHost, type RunResult as ProbeRunResult, versionOf, which } from "./probe.js";
export * from "./service.js";
export * from "./tool.js";
export * from "./types.js";

interface ToolDefLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CockpitServices {
  tools?: {
    registry: {
      get(name: string): ToolDefLike | undefined;
      info(disabled: string[]): { name: string; description: string; dangerous: boolean; source: string; enabled: boolean }[];
    };
  };
  skills?: { list(): { id: string; enabled: boolean }[] };
  permissions?: { gate(declared: (name: string) => boolean): { decide(name: string): string } };
  settings?: { get(key: string): unknown };
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function cockpitService(s: CockpitServices, host: ProbeHost = nodeProbeHost()): CapabilityService {
  const disabled = () => arr<string>(s.settings?.get("disabledTools"));
  const gate = s.permissions?.gate((name) => Boolean(s.tools?.registry.get(name)));
  return new CapabilityService({
    host,
    tools: {
      info: () => s.tools?.registry.info(disabled()) ?? [],
      spec: (name) => s.tools?.registry.get(name),
    },
    skills: () => (s.skills?.list() ?? []).filter((k) => k.enabled).map((k) => k.id),
    mcpServers: () =>
      arr<{ name?: string; command?: string; args?: string[]; enabled?: boolean }>(s.settings?.get("mcpServers")).map((m) => ({
        name: String(m.name ?? ""),
        command: String(m.command ?? ""),
        args: arr<string>(m.args),
        enabled: m.enabled !== false,
      })),
    // Sans porte de permissions, rien n'est présumé permis : « ask ».
    decide: (name) => {
      const d = gate?.decide(name);
      return d === "allow" || d === "deny" ? d : "ask";
    },
  });
}
