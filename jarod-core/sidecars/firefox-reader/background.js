// JAROD-OS — lecture ponctuelle. Page d'événements MV3. Permissions : activeTab, scripting, storage (voir docs/E2-FIREFOX-READER-PLAN.md).
//
// Invariants :
//  - la cible est l'onglet fourni par le CLIC de l'utilisateur sur le bouton (action.onClicked) : aucune énumération d'onglets ;
//  - avant l'accord de JAROD-OS, rien du contenu de la page n'est lu (seul un identifiant de document aléatoire est posé) ;
//  - au moment de la lecture, l'onglet, le document et l'origine sont revérifiés, et l'élément doit être un élément NON de formulaire ;
//  - une seule lecture par geste ; toute navigation, fermeture, expiration ou perte du canal annule la sélection ;
//  - aucun clic, saisie, navigation ni extraction globale n'existe dans ce code.
//
// Canal : HTTP vers 127.0.0.1 (port et clé d'appairage rangés dans storage.local), défi-réponse HMAC, puis interrogation longue.
// (Pas de WebSocket : Firefox met ws:// à niveau en wss:// même vers le bouclage.)
"use strict";

const SELECTOR = /^(?:[a-z][a-z0-9-]*)?(?:#[A-Za-z][\w-]*)?(?:\.[A-Za-z][\w-]*)*$/;

/** @type {{ id: string, tabId: number, docId: string, origin: string } | null} */
let selection = null;
/** @type {{ port: number, session: string } | null} */
let link = null;
let keepAlive = null;
let polling = false;

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

async function proof(key, nonce) {
  const k = await crypto.subtle.importKey("raw", fromHex(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(nonce)));
}

async function post(port, path, body, session, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 10_000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: JSON.stringify(body || {}),
      cache: "no-store",
      credentials: "omit",
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function send(message) {
  if (!link) return;
  const l = link;
  post(l.port, "/msg", message, l.session).catch(() => dropLink());
}

function badge(tabId, text) {
  try {
    browser.action.setBadgeText({ tabId, text });
  } catch {
    /* onglet disparu */
  }
}

function clearSelection(why, notify = true) {
  const old = selection;
  selection = null;
  if (keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
  if (old) {
    badge(old.tabId, "");
    if (notify) send({ type: "invalidate", id: old.id, why });
  }
}

function dropLink() {
  link = null;
  clearSelection("canal fermé");
}

/** Ouvre la session avec JAROD-OS (bouclage) par défi-réponse. La clé n'est jamais envoyée. */
async function connect() {
  if (link) return;
  const { pairing } = await browser.storage.local.get("pairing");
  if (!pairing || !Number.isInteger(pairing.port) || !/^[0-9a-f]{64}$/.test(pairing.key)) throw new Error("non appairé");
  const { nonce } = await post(pairing.port, "/hello", {});
  const { session } = await post(pairing.port, "/auth", { proof: await proof(pairing.key, nonce) });
  if (typeof session !== "string") throw new Error("session refusée");
  link = { port: pairing.port, session };
}

/** Interrogation longue : tant qu'une sélection attend, on demande à JAROD-OS s'il a une commande de lecture. */
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (selection && link) {
      let out;
      try {
        out = await post(link.port, "/poll", {}, link.session, 30_000);
      } catch {
        dropLink();
        return;
      }
      for (const m of (out && out.messages) || []) await onCommand(m);
    }
  } finally {
    polling = false;
  }
}

/** Fonction posée dans la page au geste : NE LIT RIEN, pose seulement un identifiant de document dans le bac à sable de l'extension. */
function stampDocument() {
  const id = crypto.randomUUID();
  globalThis.__jarodDoc = id;
  return id;
}

/** Fonction exécutée dans la page APRÈS l'accord. Fixe : aucun paramètre ne la rend plus large qu'un élément simple du document principal. */
function readAgreedElement(docId, selector, origin) {
  if (globalThis.__jarodDoc !== docId) return { ok: false, reason: "document changé" };
  if (location.origin !== origin) return { ok: false, reason: "origine changée" };
  if (typeof selector !== "string" || selector.length === 0 || selector.length > 80 || !/^(?:[a-z][a-z0-9-]*)?(?:#[A-Za-z][\w-]*)?(?:\.[A-Za-z][\w-]*)*$/.test(selector)) return { ok: false, reason: "sélecteur non simple" };
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: "élément absent" };
  const tag = el.tagName;
  if (/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON|OUTPUT|FORM|FIELDSET)$/.test(tag) || el.isContentEditable || el.closest("form") || el.querySelector("input,textarea,select,button,form,[contenteditable]")) return { ok: false, reason: "élément de formulaire refusé" };
  return { ok: true, title: String(document.title).slice(0, 200), text: String(el.innerText ?? el.textContent ?? "").trim().slice(0, 500) };
}

async function onCommand(m) {
  if (!m || typeof m !== "object") return;
  if (m.type === "cancel" && selection && selection.id === m.id) return clearSelection("annulé par JAROD-OS");
  if (m.type !== "read") return;
  const fail = (reason) => send({ type: "result", id: m.id, ticket: m.ticket, ok: false, reason });
  const sel = selection;
  // 1. la lecture porte sur la sélection en cours, la même, et l'accord n'a pas expiré
  if (!sel || sel.id !== m.id || sel.tabId !== m.tabId || sel.docId !== m.docId || sel.origin !== m.origin) return fail("sélection changée");
  if (typeof m.ticket !== "string" || m.ticket.length < 16 || typeof m.expiresAt !== "number" || Date.now() > m.expiresAt) return fail("accord expiré");
  if (typeof m.selector !== "string" || m.selector.length === 0 || m.selector.length > 80 || !SELECTOR.test(m.selector)) return fail("sélecteur non simple");
  // 2. l'onglet est toujours celui du geste, sur la même origine (l'accès activeTab tombe à la navigation : l'adresse devient illisible)
  let tab;
  try {
    tab = await browser.tabs.get(sel.tabId);
  } catch {
    clearSelection("onglet fermé");
    return fail("onglet fermé");
  }
  let origin = "";
  try {
    origin = new URL(tab.url || "").origin;
  } catch {
    /* adresse illisible */
  }
  if (origin !== sel.origin) {
    clearSelection("onglet changé");
    return fail("onglet changé");
  }
  // 3. la lecture elle-même : document principal seulement, fonction fixe
  let out;
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId: sel.tabId, frameIds: [0] }, func: readAgreedElement, args: [sel.docId, m.selector, sel.origin] });
    out = r && r.result;
  } catch {
    clearSelection("page non prise en charge");
    return fail("page protégée ou non prise en charge");
  }
  // 4. rien n'a bougé pendant la lecture, sinon ce qui a été lu est jeté
  try {
    const after = await browser.tabs.get(sel.tabId);
    if (!selection || selection.id !== sel.id || new URL(after.url || "").origin !== sel.origin) return fail("onglet changé pendant la lecture");
  } catch {
    return fail("onglet changé pendant la lecture");
  }
  clearSelection("lecture faite", false); // une seule lecture par geste (JAROD-OS reçoit le résultat, pas une annulation)
  if (!out || out.ok !== true) return fail((out && out.reason) || "lecture refusée");
  send({ type: "result", id: m.id, ticket: m.ticket, ok: true, title: out.title, text: out.text });
}

browser.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== "number") return;
  clearSelection("nouveau geste");
  if (link) {
    // une session neuve à chaque geste : la précédente est close d'abord
    const old = link;
    link = null;
    await post(old.port, "/bye", {}, old.session, 3000).catch(() => undefined);
  }
  let url;
  try {
    url = new URL(tab.url || "");
  } catch {
    return badge(tab.id, "×");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return badge(tab.id, "×"); // pages internes, PDF, extensions…
  try {
    await connect();
    const [r] = await browser.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: stampDocument });
    const docId = r && r.result;
    if (typeof docId !== "string") return badge(tab.id, "×");
    selection = { id: crypto.randomUUID(), tabId: tab.id, docId, origin: url.origin };
    send({ type: "select", id: selection.id, tabId: tab.id, docId, origin: url.origin, url: `${url.origin}${url.pathname}` });
    badge(tab.id, "?");
    // la page d'événements s'endort sans activité : tant qu'une sélection attend, on la tient éveillée
    keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), 10_000);
    void pollLoop();
  } catch {
    link = null;
    badge(tab.id, "×");
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (selection && selection.tabId === tabId) clearSelection("onglet fermé");
});

browser.tabs.onUpdated.addListener((tabId, change) => {
  if (selection && selection.tabId === tabId && (change.url !== undefined || change.status === "loading")) clearSelection("navigation");
});
