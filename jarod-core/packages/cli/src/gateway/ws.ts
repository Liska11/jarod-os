// Serveur WebSocket minimal (RFC 6455), écrit à la main sur le `upgrade` de `node:http` : zéro dépendance, comme le serveur MCP de
// `jarod mcp`. Il ne sait que ce dont la passerelle a besoin : trames texte (fragmentées ou non), ping/pong, fermeture.
// Les trames du client sont masquées (obligatoire), celles du serveur ne le sont pas. Taille d'un message bornée.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Un message plus gros ferme la connexion (code 1009) : la passerelle n'échange que du JSON court. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface WsConnection {
  send(text: string): void;
  close(code?: number): void;
  readonly closed: boolean;
}

export interface WsHandlers {
  onText(text: string): void;
  onClose(): void;
}

/** `Sec-WebSocket-Accept` pour une clé du client (pur ; vecteur de la RFC 6455 §1.3 testé). */
export function acceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + GUID).digest("base64");
}

/** Une trame sortante, sans masque (pur). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  let header: Buffer;
  if (n < 126) {
    header = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/**
 * Décode la première trame complète de `buf` (pur). `null` = pas encore assez d'octets ; `"too-big"` / `"unmasked"` = violation.
 * Rend aussi le nombre d'octets consommés.
 */
export function decodeFrame(buf: Buffer): { frame: DecodedFrame; used: number } | null | "too-big" | "unmasked" {
  if (buf.length < 2) return null;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return "too-big";
    len = Number(big);
    offset = 10;
  }
  if (len > MAX_MESSAGE_BYTES) return "too-big";
  if (!masked) return "unmasked";
  if (buf.length < offset + 4 + len) return null;
  const mask = buf.subarray(offset, offset + 4);
  const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { frame: { fin, opcode, payload }, used: offset + 4 + len };
}

/**
 * Termine la poignée de main et branche les gestionnaires. `null` (et le socket est fermé avec un 400) si la requête n'est pas une
 * mise à niveau WebSocket valide.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, handlers: WsHandlers): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`, "", ""].join("\r\n"),
  );

  let closed = false;
  let pending: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;

  const conn: WsConnection = {
    get closed() {
      return closed;
    },
    send(text) {
      if (closed) return;
      socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    },
    close(code = 1000) {
      if (closed) return;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.write(encodeFrame(0x8, payload));
      closed = true;
      socket.end();
    },
  };

  const finish = () => {
    closed = true;
    handlers.onClose();
  };

  const drain = () => {
    for (;;) {
      const r = decodeFrame(pending);
      if (r === null) return;
      if (r === "too-big") return conn.close(1009);
      if (r === "unmasked") return conn.close(1002);
      pending = pending.subarray(r.used);
      const { fin, opcode, payload } = r.frame;
      if (opcode === 0x8) return conn.close(1000);
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_MESSAGE_BYTES) return conn.close(1009);
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          fragmentBytes = 0;
          handlers.onText(text);
        }
        continue;
      }
      return conn.close(1003); // binaire : non pris en charge
    }
  };

  socket.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    drain();
  });
  socket.on("close", finish);
  socket.on("error", () => socket.destroy());
  if (head.length) {
    pending = Buffer.from(head);
    drain();
  }
  return conn;
}
