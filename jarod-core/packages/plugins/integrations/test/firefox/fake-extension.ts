// Une FAUSSE extension pour les essais du canal : des requêtes HTTP écrites à la main, pour pouvoir poser n'importe quel en-tête (Origin, Host, Content-Type)
// et envoyer n'importe quel corps, y compris ceux qu'une vraie extension ne produirait jamais.
import { createHmac } from "node:crypto";
import { request } from "node:http";

export interface Reply {
  status: number;
  json?: Record<string, unknown>;
}

export interface RequestOptions {
  origin?: string | null;
  host?: string;
  session?: string;
  contentType?: string | null;
  method?: string;
  raw?: string | Buffer;
}

export function post(port: number, path: string, body: unknown, o: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const payload = o.raw ?? JSON.stringify(body ?? {});
    const headers: Record<string, string | number> = { Host: o.host ?? `127.0.0.1:${port}`, "Content-Length": Buffer.byteLength(payload) };
    if (o.origin !== null) headers.Origin = o.origin ?? "moz-extension://00000000-0000-0000-0000-000000000000";
    if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
    if (o.session) headers.Authorization = `Bearer ${o.session}`;
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "POST", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let json: Record<string, unknown> | undefined;
        try {
          json = b ? (JSON.parse(b) as Record<string, unknown>) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, ...(json ? { json } : {}) });
      });
    });
    req.on("error", () => resolve({ status: 0 }));
    req.end(payload);
  });
}

export class FakeExtension {
  readonly messages: Record<string, unknown>[] = [];
  private alive = true;
  private polling = false;

  private constructor(
    readonly port: number,
    readonly session: string,
  ) {}

  /** Ouvre une session comme le fait l'extension : « hello », preuve HMAC, « auth ». Rend le code HTTP du premier échec. */
  static async open(port: number, pairingCode: string, o: RequestOptions = {}): Promise<{ status: number; ext?: FakeExtension }> {
    const hello = await post(port, "/hello", {}, o);
    if (hello.status !== 200 || typeof hello.json?.nonce !== "string") return { status: hello.status };
    const key = Buffer.from(pairingCode.split(".")[2] ?? "", "hex");
    const auth = await post(port, "/auth", { proof: createHmac("sha256", key).update(hello.json.nonce).digest("hex") }, o);
    if (auth.status !== 200 || typeof auth.json?.session !== "string") return { status: auth.status };
    return { status: 200, ext: new FakeExtension(port, auth.json.session) };
  }

  /** Une requête avec le jeton de session. */
  call(path: string, body: unknown, o: RequestOptions = {}): Promise<Reply> {
    return post(this.port, path, body, { session: this.session, ...o });
  }

  send(m: Record<string, unknown>): Promise<Reply> {
    return this.call("/msg", m);
  }

  /** Interroge en boucle (comme l'extension tant qu'une sélection attend) et range ce qui arrive dans `messages`. */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void (async () => {
      while (this.alive) {
        const r = await this.call("/poll", {});
        if (r.status !== 200) return void (this.polling = false);
        for (const m of (r.json?.messages as Record<string, unknown>[] | undefined) ?? []) this.messages.push(m);
      }
      this.polling = false;
    })();
  }

  async next(type: string, ms = 5000): Promise<Record<string, unknown> | undefined> {
    const end = Date.now() + ms;
    while (!this.messages.some((m) => m.type === type) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return this.messages.find((m) => m.type === type);
  }

  /** Cesse d'interroger : c'est ce que fait une extension qui meurt ou dont l'onglet se ferme. */
  stop(): void {
    this.alive = false;
  }

  bye(): Promise<Reply> {
    this.alive = false;
    return this.call("/bye", {});
  }
}
