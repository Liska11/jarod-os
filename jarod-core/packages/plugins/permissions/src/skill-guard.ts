// Portage de packages/core/src/services/skill-guard.ts (rév. 2e180305).
/**
 * Static scan of a skill before it is installed. A skill is text the agent will obey and scripts it
 * may run, so a third-party one is checked for the usual tricks: prompt injection, credential
 * exfiltration, destructive or persistent commands, obfuscation and invisible characters.
 *
 * The rules are a subset of Hermes Agent's `tools/skills_guard.py` (MIT, Nous Research). A scan is
 * a filter, not a proof: `caution` findings are shown to the user, `dangerous` blocks the install.
 */

export type Severity = "critical" | "high" | "medium";
export type Verdict = "safe" | "caution" | "dangerous";

export interface GuardFinding {
  rule: string;
  severity: Severity;
  category: "injection" | "exfiltration" | "destructive" | "persistence" | "network" | "obfuscation";
  file: string;
  line: number;
  excerpt: string;
}

export interface GuardReport {
  verdict: Verdict;
  findings: GuardFinding[];
}

type Rule = [RegExp, string, Severity, GuardFinding["category"]];

const SECRET = String.raw`(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const NOT_LOCAL = String.raw`(?![^\n]*https?://(?:localhost|127\.0\.0\.1|\[::1\]))`;

const RULES: Rule[] = [
  // Prompt injection: text that tries to take over the agent.
  [/ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+instructions/i, "ignore_instructions", "critical", "injection"],
  [
    /disregard\s+(?:\w+\s+)*(?:your|all|any)\s+(?:\w+\s+)*(?:instructions|rules|guidelines)/i,
    "disregard_rules",
    "critical",
    "injection",
  ],
  [/you\s+are\s+(?:\w+\s+)*now\s+/i, "role_hijack", "high", "injection"],
  [/pretend\s+(?:\w+\s+)*(?:you\s+are|to\s+be)\s+/i, "pretend_role", "high", "injection"],
  [/system\s+(?:\w+\s+)*prompt\s+(?:\w+\s+)*override/i, "prompt_override", "critical", "injection"],
  [/output\s+(?:\w+\s+)*(?:system|initial)\s+prompt/i, "prompt_leak", "high", "injection"],
  [
    /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user(?!.*\b(?:unless|except|until|confirm)\b)/i,
    "hide_from_user",
    "critical",
    "injection",
  ],
  [/(?:when|if)\s+no\s*one\s+is\s+(?:watching|looking)/i, "unobserved", "high", "injection"],
  [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, "hidden_comment", "high", "injection"],
  [/<\s*div\s+style\s*=\s*["'][^"']*display\s*:\s*none/i, "hidden_html", "high", "injection"],
  // Exfiltration: secrets or credential files sent or read.
  [
    new RegExp(String.raw`\b(?:curl|wget)\s+${NOT_LOCAL}[^\n]*\$\{?\w*${SECRET}`, "i"),
    "http_secret_exfil",
    "critical",
    "exfiltration",
  ],
  [
    new RegExp(String.raw`\bfetch\s*\(${NOT_LOCAL}[^\n]*\$\{?\w*${SECRET}`, "i"),
    "fetch_secret_exfil",
    "critical",
    "exfiltration",
  ],
  [/(?:\$HOME|~|%USERPROFILE%)[/\\]\.(?:ssh|aws|gnupg|kube|docker)\b/i, "credential_dir", "high", "exfiltration"],
  [
    /\bcat\s+(?!>)[^\n]*(?:\.env\b|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    "read_secret_file",
    "high",
    "exfiltration",
  ],
  [/\bprintenv\b|\benv\s*\|/i, "dump_env", "high", "exfiltration"],
  [/!?\[[^\]]*\]\(https?:\/\/[^)]*\$\{?/i, "markdown_exfil", "high", "exfiltration"],
  [
    /webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com|pastebin\.com|hastebin\.com/i,
    "exfil_service",
    "high",
    "exfiltration",
  ],
  // Destruction.
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:\/|~|\$HOME)(?:\s|$)/i, "rm_root", "critical", "destructive"],
  [
    /\bRemove-Item\b[^\n]*-Recurse[^\n]*(?:C:\\|\$env:USERPROFILE|~)(?:\s|$|\\?\*)/i,
    "ps_remove_root",
    "critical",
    "destructive",
  ],
  [/\bmkfs\b|\bdd\s+[^\n]*of=\/dev\/|\bformat\s+[a-z]:/i, "disk_wipe", "critical", "destructive"],
  [/>\s*\/etc\//, "system_overwrite", "critical", "destructive"],
  [/chmod\s+777/, "insecure_perms", "medium", "destructive"],
  // Persistence.
  [/authorized_keys|\/etc\/sudoers|\bvisudo\b/i, "privilege_backdoor", "critical", "persistence"],
  [/\bcrontab\b|\bschtasks\s+\/create\b|\\CurrentVersion\\Run\b/i, "autostart", "medium", "persistence"],
  [/\.(?:bashrc|zshrc|bash_profile|zprofile)\b|\$PROFILE\b/, "shell_profile", "medium", "persistence"],
  // Network.
  [/\bnc\s+-[lp]|\bncat\s+-[lp]|\bngrok\b|\bcloudflared\b|\blocaltunnel\b/i, "tunnel_listener", "high", "network"],
  // Obfuscation.
  [/base64\s+(?:-d|--decode)\s*\|\s*(?:ba|z)?sh/i, "base64_pipe_shell", "critical", "obfuscation"],
  [
    /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
    "pipe_to_shell",
    "high",
    "obfuscation",
  ],
  [
    /\b(?:iex|Invoke-Expression)\b\s*\(?\s*(?:\(|\$|iwr|Invoke-WebRequest|New-Object)/i,
    "ps_iex",
    "high",
    "obfuscation",
  ],
  [/-(?:enc|EncodedCommand)\s+[A-Za-z0-9+/=]{20,}/, "ps_encoded", "critical", "obfuscation"],
  [/\beval\s*\(\s*(?:atob|Buffer\.from|base64)/i, "eval_decoded", "critical", "obfuscation"],
];

/** Zero-width and bidirectional-override characters: text the user cannot see but the model reads. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export function scanSkillFiles(files: { path: string; text: string }[]): GuardReport {
  const findings: GuardFinding[] = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      // A BOM at the very start of a file is an encoding mark, not a hidden instruction.
      const visible = i === 0 ? line.replace(/^\uFEFF/, "") : line;
      if (INVISIBLE.test(visible)) {
        findings.push({
          rule: "invisible_chars",
          severity: "critical",
          category: "injection",
          file: f.path,
          line: i + 1,
          excerpt: excerpt(visible),
        });
      }
      for (const [re, rule, severity, category] of RULES) {
        if (re.test(visible))
          findings.push({ rule, severity, category, file: f.path, line: i + 1, excerpt: excerpt(visible) });
      }
    });
  }
  const verdict: Verdict = findings.some((f) => f.severity === "critical")
    ? "dangerous"
    : findings.length
      ? "caution"
      : "safe";
  return { verdict, findings };
}

const excerpt = (line: string) => {
  const clean = line.replace(new RegExp(INVISIBLE.source, "g"), "·").trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
};

export function describeGuardReport(r: GuardReport, max = 10): string {
  const label = { safe: "✅ aucun motif suspect", caution: "⚠️ à vérifier", dangerous: "⛔ dangereux" }[r.verdict];
  const lines = r.findings
    .slice(0, max)
    .map((f) => `- [${f.severity}] ${f.rule} — ${f.file}:${f.line} : \`${f.excerpt.replace(/`/g, "'")}\``);
  const more = r.findings.length > max ? `\n- … ${r.findings.length - max} autre(s)` : "";
  return `Analyse : ${label}${lines.length ? `\n${lines.join("\n")}${more}` : ""}`;
}
