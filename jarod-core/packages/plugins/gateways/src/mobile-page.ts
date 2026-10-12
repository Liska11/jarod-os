// Portage de packages/core/src/services/mobile-page.ts (rév. 2e180305).
/**
 * The page a phone loads. No build step, no CDN, no framework: it is served by the app itself, and
 * the pairing secret stays in the URL fragment (which a browser never sends to a server).
 */
export const MOBILE_PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarod-One</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; font:15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background:#111214; color:#e8e8ea; display:flex; flex-direction:column; height:100dvh }
  header { padding:10px 12px; border-bottom:1px solid #2a2c31; display:flex; align-items:center; gap:8px }
  header b { font-weight:600 } header span { color:#9a9ca3; font-size:12px; margin-left:auto }
  main { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px }
  .msg { border:1px solid #2a2c31; border-radius:12px; padding:8px 10px; white-space:pre-wrap; word-wrap:break-word }
  .msg.user { background:#1b1d21 } .msg.assistant { background:#16181b }
  .who { font-size:11px; color:#9a9ca3; margin-bottom:4px }
  footer { border-top:1px solid #2a2c31; padding:8px; display:flex; gap:8px }
  textarea { flex:1; resize:none; height:44px; background:#1b1d21; color:inherit; border:1px solid #2a2c31;
             border-radius:10px; padding:10px; font:inherit }
  button { background:#3a6df0; color:#fff; border:0; border-radius:10px; padding:0 16px; font:inherit; font-weight:600 }
  button.ghost { background:transparent; border:1px solid #2a2c31; color:#e8e8ea; font-weight:400 }
  .row { display:flex; flex-direction:column; gap:6px } .card { background:#16181b; border:1px solid #2a2c31;
         border-radius:12px; padding:10px; text-align:left }
  .muted { color:#9a9ca3; font-size:12px } .err { color:#ff8a8a }
  .clear { background:#3a2e12; color:#f5c451; font-size:12px; padding:6px 12px; border-bottom:1px solid #2a2c31 }
</style>
</head>
<body>
<header>
  <b>Jarod-One</b><span id="state">connexion…</span>
  <button class="ghost" id="out" hidden>Quitter</button>
</header>
<div class="clear" role="note">Connexion locale non chiffrée : à n'utiliser que sur votre Wi-Fi de confiance, jamais sur un réseau public.</div>
<main id="main"></main>
<footer id="foot" hidden>
  <textarea id="text" placeholder="Votre message…"></textarea>
  <button id="send">Envoyer</button>
</footer>
<script src="/app.js"></script>
</body>
</html>
`;

/**
 * The client script, served as its own file so the page needs no inline script (and no exception to
 * the content policy). Plain DOM, no framework: this has to run on a phone browser as it is.
 */
export const MOBILE_APP = `const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("jarod.mobile.token") || "";
let open = null;

const api = async (path, opts) => {
  const res = await fetch(path, {
    ...(opts || {}),
    headers: { "content-type": "application/json", authorization: "Bearer " + token }
  });
  if (res.status === 401) { token = ""; localStorage.removeItem("jarod.mobile.token"); throw new Error("association perdue"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
};

const pair = async () => {
  const secret = location.hash.slice(1);
  if (!secret) throw new Error("code manquant : ouvrez le lien affiché dans l'application.");
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, name: navigator.userAgent.slice(0, 60) })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "association refusée");
  token = body.token;
  localStorage.setItem("jarod.mobile.token", token);
  // Spent: the secret does not stay in the address bar or in the phone's history.
  history.replaceState(null, "", location.pathname);
};

const showList = async () => {
  open = null;
  $("foot").hidden = true;
  const sessions = await api("/api/sessions");
  const box = document.createElement("div");
  box.className = "row";
  if (!sessions.length) box.innerHTML = '<p class="muted">Aucune conversation.</p>';
  for (const s of sessions) {
    const b = document.createElement("button");
    b.className = "card";
    b.innerHTML = "<div>" + escapeHtml(s.title || "Sans titre") + '</div><div class="muted">' +
      new Date(s.updatedAt).toLocaleString() + "</div>";
    b.onclick = () => showSession(s.id);
    box.appendChild(b);
  }
  $("main").replaceChildren(box);
};

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const addMessage = (role, text) => {
  const el = document.createElement("div");
  el.className = "msg " + role;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "Vous" : "Jarod";
  const body = document.createElement("div");
  body.textContent = text;
  el.append(who, body);
  $("main").appendChild(el);
  $("main").scrollTop = $("main").scrollHeight;
  return body;
};

const showSession = async (id) => {
  open = id;
  const messages = await api("/api/session?id=" + encodeURIComponent(id));
  $("main").replaceChildren();
  for (const m of messages) addMessage(m.role, m.text);
  $("foot").hidden = false;
  $("text").focus();
  $("main").scrollTop = $("main").scrollHeight;
};

const send = async () => {
  const text = $("text").value.trim();
  if (!text || !open) return;
  $("text").value = "";
  addMessage("user", text);
  const answer = addMessage("assistant", "");
  $("state").textContent = "réflexion…";
  try {
    await api("/api/ask", { method: "POST", body: JSON.stringify({ sessionId: open, text }) });
  } catch (e) { $("state").textContent = ""; answer.textContent = "Erreur : " + e.message; }
};

const stream = () => {
  // The token rides in the query: a browser's EventSource cannot carry a header.
  const source = new EventSource("/api/events?t=" + encodeURIComponent(token));
  source.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.sessionId && open && ev.sessionId !== open) return;
    const body = $("main").lastElementChild && $("main").lastElementChild.lastElementChild;
    if (ev.type === "delta") { if (body) body.textContent += ev.text || ""; $("main").scrollTop = $("main").scrollHeight; }
    else if (ev.type === "stream-reset") { if (body) body.textContent = ""; }
    else if (ev.type === "message" && ev.message && ev.message.role === "assistant") {
      $("state").textContent = "";
      if (body) body.textContent = ev.message.content || body.textContent || "(pas de réponse)";
    }
    else if (ev.type === "done") { $("state").textContent = ""; }
    else if (ev.type === "error") { $("state").textContent = ""; if (body) body.textContent = "Erreur : " + (ev.error || "inconnue"); }
  };
  source.onerror = () => { $("state").textContent = "hors ligne"; };
};

$("send").onclick = send;
$("out").onclick = async () => { try { await api("/api/leave", { method: "POST" }); } catch (e) {} token = ""; localStorage.removeItem("jarod.mobile.token"); location.reload(); };

(async () => {
  try {
    if (!token) await pair();
    const status = await api("/api/status");
    $("state").textContent = status.model || status.app;
    $("out").hidden = false;
    stream();
    await showList();
  } catch (e) {
    $("main").innerHTML = '<p class="err">' + escapeHtml(e.message) + "</p>";
  }
})();
`;
