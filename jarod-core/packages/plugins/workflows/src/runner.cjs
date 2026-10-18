/**
 * Processus d'UN plugin utilisateur (U2, gap G6) — Jarod-cordis. Lancé par `PluginHost` (plugins.ts) :
 * `utilityProcess.fork` sous Electron, `child_process.fork` ailleurs, TOUJOURS avec le modèle de permissions
 * de Node (`--permission` : lecture = ce fichier + le dossier du plugin, écriture = son `data/`, ni
 * processus enfant, ni worker, ni addon natif). Le réseau n'a pas de drapeau dans Node 24 (`--allow-net`
 * arrive en 25) : sans la permission `network`, les points d'entrée réseau de Node sont remplacés par un
 * refus, non modifiable, AVANT le chargement du plugin.
 *
 * Le plugin reçoit la même `PluginApi` que dans la source (`services/plugins.ts:33-67`, rév. 2e180305) ;
 * chaque surface exige sa permission déclarée dans `plugin.json` (`tools`, `commands`, `hooks`, `routes`,
 * `pages`, `notify`), sinon l'appel lève PERMISSION_DENIED. Ses contributions partent à l'hôte en fin
 * d'`activate` ; l'hôte les appelle ensuite par messages (`call` → `result`). CommonJS sans dépendance :
 * il est exécuté tel quel, sans compilation.
 */
"use strict";

const port = process.parentPort; // utilityProcess
const send = (m) => (port ? port.postMessage(m) : process.send(m));
const onMessage = (fn) => (port ? port.on("message", (e) => fn(e.data)) : process.on("message", fn));

const denied = (what) =>
  Object.assign(new Error(`PERMISSION_DENIED: ${what}`), { code: "ERR_ACCESS_DENIED" });

/** Réseau sortant ET entrant refusé : sockets TCP/TLS/UDP, écoute, DNS (fetch, http(s), WebSocket passent par là). */
function denyNetwork() {
  const lock = (obj, key, what) => {
    Object.defineProperty(obj, key, {
      value() {
        throw denied(`réseau non déclaré (${what}) — ajoutez "network" aux permissions de plugin.json`);
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });
  };
  const net = require("node:net");
  lock(net.Socket.prototype, "connect", "net.Socket.connect");
  lock(net.Server.prototype, "listen", "net.Server.listen");
  const dgram = require("node:dgram");
  lock(dgram.Socket.prototype, "bind", "dgram.bind");
  lock(dgram.Socket.prototype, "send", "dgram.send");
  lock(dgram.Socket.prototype, "connect", "dgram.connect");
  const dns = require("node:dns");
  for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "lookupService"]) lock(dns, k, `dns.${k}`);
  for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "lookupService"]) lock(dns.promises, k, `dns.promises.${k}`);
}

let mod = null;
let permissions = new Set();
const tools = new Map();
const commands = new Map();
const routes = new Map();
const pages = new Map();
const before = [];
const after = [];

const need = (p) => {
  if (!permissions.has(p)) throw denied(`permission « ${p} » non déclarée dans plugin.json`);
};

async function activate(m) {
  permissions = new Set(m.permissions);
  if (!permissions.has("network")) denyNetwork();
  const { createRequire } = require("node:module");
  const { join } = require("node:path");
  const req = createRequire(join(m.root, "plugin.json"));
  mod = req(m.mainPath);
  if (!mod || typeof mod.activate !== "function") throw new Error("Le module doit exporter activate(api)");
  const registrations = [];
  const api = {
    id: m.id,
    dataDir: m.dataDir,
    registerTool(def) {
      need("tools");
      tools.set(def.name, def);
      registrations.push({
        kind: "tool",
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        dangerous: Boolean(def.dangerous),
      });
    },
    registerCommand(def) {
      need("commands");
      commands.set(def.name, def);
      registrations.push({ kind: "command", name: def.name, description: def.description, usage: def.usage });
    },
    onBeforeSend(fn) {
      need("hooks");
      before.push(fn);
    },
    onAfterResponse(fn) {
      need("hooks");
      after.push(fn);
    },
    notify(title, body = "") {
      need("notify");
      send({ t: "notify", title: String(title), body: String(body) });
    },
    log(...args) {
      send({ t: "log", text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
    },
    registerRoute(method, path, handler) {
      need("routes");
      routes.set(`${String(method).toUpperCase()} ${path}`, handler);
      registrations.push({ kind: "route", method: String(method), path: String(path) });
    },
    registerPage(def) {
      need("pages");
      pages.set(def.id, def);
      registrations.push({ kind: "page", id: def.id, title: def.title, description: def.description });
    },
  };
  await mod.activate(api);
  return { registrations, hooks: { beforeSend: before.length > 0, afterResponse: after.length > 0 } };
}

async function call(m) {
  switch (m.kind) {
    case "tool": {
      const t = tools.get(m.name);
      if (!t) throw new Error(`outil inconnu : ${m.name}`);
      return String(await t.run(m.args ?? {}, m.ctx ?? {}));
    }
    case "command": {
      const c = commands.get(m.name);
      if (!c) throw new Error(`commande inconnue : ${m.name}`);
      const r = await c.run(m.args ?? "", m.ctx ?? {});
      return typeof r === "string" ? { text: r } : r;
    }
    case "route": {
      const h = routes.get(m.name);
      if (!h) throw new Error(`route inconnue : ${m.name}`);
      return await h(m.args);
    }
    case "page": {
      const p = pages.get(m.name);
      if (!p) throw new Error(`page inconnue : ${m.name}`);
      return String(await p.render());
    }
    case "beforeSend": {
      // Même règle que la source (plugins.ts:236-249) : une fonction qui lève est journalisée et sautée.
      let out = m.args;
      for (const fn of before) {
        try {
          const r = fn(out);
          if (typeof r === "string") out = r;
        } catch (e) {
          send({ t: "log", text: `beforeSend : ${e && e.message}` });
        }
      }
      return out;
    }
    case "afterResponse": {
      for (const fn of after) {
        try {
          fn(m.args.text, m.args.sessionId);
        } catch (e) {
          send({ t: "log", text: `afterResponse : ${e && e.message}` });
        }
      }
      return null;
    }
    default:
      throw new Error(`appel inconnu : ${m.kind}`);
  }
}

onMessage(async (m) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "activate") {
    try {
      send({ t: "activated", ...(await activate(m)) });
    } catch (e) {
      send({ t: "activate-failed", error: String(e?.message || e) });
    }
  } else if (m.t === "call") {
    try {
      send({ t: "result", seq: m.seq, ok: true, value: await call(m) });
    } catch (e) {
      send({ t: "result", seq: m.seq, ok: false, error: String(e?.message || e) });
    }
  } else if (m.t === "deactivate") {
    try {
      await (mod?.deactivate ? mod.deactivate() : undefined);
    } catch (e) {
      send({ t: "log", text: `deactivate : ${e && e.message}` });
    }
    send({ t: "deactivated" });
  }
});

send({ t: "ready", pid: process.pid, node: process.versions.node, permission: Boolean(process.permission) });
