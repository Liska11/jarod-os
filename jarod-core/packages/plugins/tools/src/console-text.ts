// Portage de packages/core/src/console-text.ts (rév. 2e180305).
import { execFileSync } from "node:child_process";

/**
 * What a Windows console program prints is not always UTF-8. `cmd.exe` and its built-ins (`dir`, its
 * own error messages…) write in the console's OEM code page — 850 on a French Windows — so reading
 * their output as UTF-8 turns « exécutable » into « ex�cutable ». `chcp 65001` on the same line does
 * not help: cmd has already chosen its code page. Programs such as node or git, on the other hand, do
 * write UTF-8. Hence the rule: UTF-8 when the bytes are valid UTF-8, the OEM code page otherwise.
 *
 * Node's TextDecoder knows no OEM code page but 866, so the Western ones are tables here, generated
 * from Windows itself (`[System.Text.Encoding]::GetEncoding(n).GetString(0x80..0xFF)`).
 */
const OEM_HIGH_HALF: Record<number, string> = {
  437: "c7,fc,e9,e2,e4,e0,e5,e7,ea,eb,e8,ef,ee,ec,c4,c5,c9,e6,c6,f4,f6,f2,fb,f9,ff,d6,dc,a2,a3,a5,20a7,192,e1,ed,f3,fa,f1,d1,aa,ba,bf,2310,ac,bd,bc,a1,ab,bb,2591,2592,2593,2502,2524,2561,2562,2556,2555,2563,2551,2557,255d,255c,255b,2510,2514,2534,252c,251c,2500,253c,255e,255f,255a,2554,2569,2566,2560,2550,256c,2567,2568,2564,2565,2559,2558,2552,2553,256b,256a,2518,250c,2588,2584,258c,2590,2580,3b1,df,393,3c0,3a3,3c3,b5,3c4,3a6,398,3a9,3b4,221e,3c6,3b5,2229,2261,b1,2265,2264,2320,2321,f7,2248,b0,2219,b7,221a,207f,b2,25a0,a0",
  850: "c7,fc,e9,e2,e4,e0,e5,e7,ea,eb,e8,ef,ee,ec,c4,c5,c9,e6,c6,f4,f6,f2,fb,f9,ff,d6,dc,f8,a3,d8,d7,192,e1,ed,f3,fa,f1,d1,aa,ba,bf,ae,ac,bd,bc,a1,ab,bb,2591,2592,2593,2502,2524,c1,c2,c0,a9,2563,2551,2557,255d,a2,a5,2510,2514,2534,252c,251c,2500,253c,e3,c3,255a,2554,2569,2566,2560,2550,256c,a4,f0,d0,ca,cb,c8,131,cd,ce,cf,2518,250c,2588,2584,a6,cc,2580,d3,df,d4,d2,f5,d5,b5,fe,de,da,db,d9,fd,dd,af,b4,ad,b1,2017,be,b6,a7,f7,b8,b0,a8,b7,b9,b3,b2,25a0,a0",
  858: "c7,fc,e9,e2,e4,e0,e5,e7,ea,eb,e8,ef,ee,ec,c4,c5,c9,e6,c6,f4,f6,f2,fb,f9,ff,d6,dc,f8,a3,d8,d7,192,e1,ed,f3,fa,f1,d1,aa,ba,bf,ae,ac,bd,bc,a1,ab,bb,2591,2592,2593,2502,2524,c1,c2,c0,a9,2563,2551,2557,255d,a2,a5,2510,2514,2534,252c,251c,2500,253c,e3,c3,255a,2554,2569,2566,2560,2550,256c,a4,f0,d0,ca,cb,c8,20ac,cd,ce,cf,2518,250c,2588,2584,a6,cc,2580,d3,df,d4,d2,f5,d5,b5,fe,de,da,db,d9,fd,dd,af,b4,ad,b1,2017,be,b6,a7,f7,b8,b0,a8,b7,b9,b3,b2,25a0,a0",
};

const tables = new Map<number, string[]>();

function tableFor(codePage: number): string[] | null {
  const cached = tables.get(codePage);
  if (cached) return cached;
  const raw = OEM_HIGH_HALF[codePage];
  if (!raw) return null;
  const table = raw.split(",").map((hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  tables.set(codePage, table);
  return table;
}

let detected: number | null | undefined;

/** The console's OEM code page on Windows (`chcp`), read once; null elsewhere or when unknown. */
export function consoleCodePage(): number | null {
  if (detected !== undefined) return detected;
  detected = null;
  if (process.platform !== "win32") return detected;
  try {
    // « Page de codes active : 850 », « Active code page: 437 » — the number is the last thing said.
    const out = execFileSync("cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 5_000 }).toString("latin1");
    const match = /(\d+)\D*$/.exec(out);
    detected = match ? Number(match[1]) : null;
  } catch {
    detected = null;
  }
  return detected;
}

/** Decodes bytes in a single-byte OEM code page. Null when the code page is not one we know. */
function decodeOem(bytes: Uint8Array, codePage: number): string | null {
  if (codePage === 866) return new TextDecoder("ibm866").decode(bytes);
  const table = tableFor(codePage);
  if (!table) return null;
  let out = "";
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80];
  return out;
}

/** Complete output of a console program: UTF-8 if it is valid UTF-8, the OEM code page otherwise. */
export function decodeConsoleOutput(bytes: Uint8Array, codePage: number | null = consoleCodePage()): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return (codePage !== null && decodeOem(bytes, codePage)) || Buffer.from(bytes).toString("utf8");
  }
}

/**
 * The same rule for output that arrives in chunks (a live terminal). A UTF-8 character cut between two
 * chunks is held back until it is complete; a chunk that is not UTF-8 is read in the OEM code page.
 */
export class ConsoleDecoder {
  private utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly codePage: number | null = consoleCodePage()) {}

  write(chunk: Uint8Array): string {
    try {
      return this.utf8.decode(chunk, { stream: true });
    } catch {
      // The decoder is spent after an error: a fresh one for the next chunk.
      this.utf8 = new TextDecoder("utf-8", { fatal: true });
      return decodeConsoleOutput(chunk, this.codePage);
    }
  }

  /** Whatever is still held back, once the stream is over. */
  end(): string {
    try {
      return this.utf8.decode();
    } catch {
      return "";
    }
  }
}
