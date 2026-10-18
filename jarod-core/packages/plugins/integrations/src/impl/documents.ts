/**
 * B3 (docling) et B5 (markitdown) — analyse de documents par un sidecar Python.
 *
 * Le sidecar tourne par la porte unique : l'adaptateur ne lance rien, il construit l'appel (`run_shell`, isolation
 * « workspace ») et nettoie la sortie. Types de fichier permis par liste blanche, taille bornée AVANT l'appel, chemin
 * dans la zone, sortie bornée et débarrassée des caractères de contrôle. L'OCR de markitdown (PyMuPDF, AGPL) est une
 * option explicite : politique du 2026-10-17, licence informative.
 */
import { AdapterRefused, AdapterUnavailable, type GuardedCall } from "./common.js";

export interface ParserSpec {
  id: "B3" | "B5";
  tool: "docling" | "markitdown";
  extensions: string[];
  maxBytes: number;
  maxOutputChars: number;
  /** Début de la commande, avant le chemin du document. Le profil Docling sans PyTorch n'a pas de CLI utilisable : un petit script natif la remplace. */
  launcher: string;
}

export const DOCLING: ParserSpec = { id: "B3", tool: "docling", extensions: [".pdf", ".docx", ".pptx", ".xlsx", ".html"], maxBytes: 50_000_000, maxOutputChars: 400_000, launcher: 'python "jarod-core/sidecars/docling-md/docling_md.py"' };
export const MARKITDOWN: ParserSpec = { id: "B5", tool: "markitdown", extensions: [".pdf", ".docx", ".pptx", ".xlsx", ".html", ".csv", ".json", ".xml", ".txt"], maxBytes: 50_000_000, maxOutputChars: 400_000, launcher: "markitdown" };

const SAFE_PATH = /^[A-Za-z0-9_@%+=,.\-/ ]+$/;

export interface ParseRequest {
  /** Chemin relatif à la zone. */
  path: string;
  sizeBytes: number;
  /** markitdown : activer les extensions OCR (PyMuPDF). */
  ocr?: boolean;
}

export function planParse(spec: ParserSpec, req: ParseRequest, sidecarAvailable: boolean): GuardedCall {
  if (!sidecarAvailable) throw new AdapterUnavailable(spec.id, `sidecar ${spec.tool} non installé (action humaine)`);
  if (/^[\\/]/.test(req.path) || /^[A-Za-z]:/.test(req.path) || req.path.split(/[\\/]/).includes("..") || !SAFE_PATH.test(req.path)) throw new AdapterRefused(spec.id, "chemin hors zone ou caractères non sûrs");
  const ext = req.path.slice(req.path.lastIndexOf(".")).toLowerCase();
  if (!spec.extensions.includes(ext)) throw new AdapterRefused(spec.id, `type ${ext} non permis`);
  if (!(req.sizeBytes >= 0) || req.sizeBytes > spec.maxBytes) throw new AdapterRefused(spec.id, `taille ${req.sizeBytes} > ${spec.maxBytes}`);
  if (req.ocr && spec.id !== "B5") throw new AdapterRefused(spec.id, "OCR : option de markitdown seulement");
  const ocr = req.ocr ? " --use-plugins" : "";
  return { name: "run_shell", args: { command: `${spec.launcher} "${req.path}"${ocr}`, isolation: "workspace", timeout_seconds: 300 } };
}

export interface ParsedDocument {
  markdown: string;
  truncated: boolean;
}

/** Sortie du sidecar : texte seulement, sans caractères de contrôle ni séquences d'échappement, bornée. */
export function cleanOutput(spec: ParserSpec, raw: string): ParsedDocument {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, matches ANSI escape sequences (ESC) and control characters
  const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  return text.length > spec.maxOutputChars ? { markdown: text.slice(0, spec.maxOutputChars), truncated: true } : { markdown: text, truncated: false };
}
