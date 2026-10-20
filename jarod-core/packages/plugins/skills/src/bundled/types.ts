/** Un lot de skills EMBARQUÉES dans le code (cockpit, lot 3) : provenance épinglée, licence, et le texte des fichiers. */
export interface BundledPack {
  pack: string;
  repo: string;
  commit: string;
  license: string;
  licenseText: string;
  skills: Record<string, { origin: string; files: Record<string, string> }>;
}
