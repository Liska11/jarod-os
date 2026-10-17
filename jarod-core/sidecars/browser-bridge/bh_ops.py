"""Pont E2 : un jeu FERMÉ d'opérations sur browser-harness, pour le navigateur d'essai jetable.

Une requête JSON sur l'entrée standard ({"op": ..., ...}), une réponse JSON sur la sortie standard. Ce pont n'expose NI `run.py`
(qui exécute du code d'agent), NI les aides écrites par l'agent (`agent_helpers.py`), NI le CDP brut, NI les compétences de domaine :
seules les opérations de OPS existent. Il REFUSE de démarrer si l'environnement ne désigne pas un navigateur de bouclage lancé par
Jarod (JAROD_BROWSER_CDP) avec un profil jetable (JAROD_BROWSER_PROFILE) : sans cela, browser-harness irait chercher le Chrome
quotidien de l'utilisateur, ce que ce pont ne fait jamais.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

OPS = ("list_tabs", "open_tab", "read_page", "navigate", "click", "type_text", "press_key", "is_password_field", "close_tab", "shutdown")
KEYS = {"enter": "Enter", "tab": "Tab", "escape": "Escape", "up": "ArrowUp", "down": "ArrowDown",
        "pageup": "PageUp", "pagedown": "PageDown", "home": "Home", "end": "End"}
NAME_RE = re.compile(r"\A[A-Za-z0-9_-]{1,40}\Z")


def refuse(message: str) -> "None":
    sys.stdout.write(json.dumps({"ok": False, "error": message}) + "\n")
    sys.exit(2)


def sandbox_env() -> str:
    """Valide l'environnement AVANT tout import de browser_harness ; rend le nom du démon."""
    cdp = os.environ.get("JAROD_BROWSER_CDP", "")
    u = urlparse(cdp)
    if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1") or not u.port or u.username or u.password:
        refuse("JAROD_BROWSER_CDP doit être http://127.0.0.1:<port> (navigateur de bouclage lancé par Jarod)")
    profile = os.environ.get("JAROD_BROWSER_PROFILE", "")
    if not profile or not Path(profile).is_dir():
        refuse("JAROD_BROWSER_PROFILE (profil jetable) absent")
    real = Path(profile).resolve()
    tmp = Path(tempfile.gettempdir()).resolve()
    if tmp not in real.parents or not real.name.startswith("jarod-e2-"):
        refuse("le profil doit être un dossier jetable jarod-e2-* du dossier temporaire")
    name = os.environ.get("JAROD_BROWSER_NAME", "jarod-e2")
    if not NAME_RE.match(name):
        refuse("nom de démon invalide")
    state = real / "bh-state"
    work = real / "bh-work"
    state.mkdir(exist_ok=True)
    work.mkdir(exist_ok=True)
    if (work / "agent_helpers.py").exists():
        refuse("agent_helpers.py présent : le pont ne charge aucun code écrit par l'agent")
    os.environ.update({
        "BU_CDP_URL": cdp, "BU_NAME": name,
        "BH_HOME": str(state), "BH_CONFIG_DIR": str(state), "BH_RUNTIME_DIR": str(state / "run"), "BH_TMP_DIR": str(state / "tmp"),
        "BH_AGENT_WORKSPACE": str(work),
        "BH_TELEMETRY": "0", "BROWSER_HARNESS_TELEMETRY": "0", "ANONYMIZED_TELEMETRY": "0",
        "BH_UPDATE_CHECK": "0", "BH_TAB_MARKER": "0", "BH_RECORD": "0",
    })
    for k in ("BU_CDP_WS", "BU_BROWSER_ID", "BU_AUTOSPAWN", "BROWSER_USE_API_KEY", "BH_DOMAIN_SKILLS"):
        os.environ.pop(k, None)
    return name


def js_str(value: str) -> str:
    return json.dumps(value)


def run(op: str, req: dict, h) -> object:
    tab = req.get("tab")
    if op == "list_tabs":
        return [{"id": t["targetId"], "url": t["url"], "title": t["title"]} for t in h.list_tabs(include_chrome=False)]
    if op == "open_tab":
        url = str(req.get("url", ""))
        if urlparse(url).scheme not in ("http", "https"):
            raise ValueError("adresse non permise")
        tid = h.new_tab(url)
        h.wait_for_load(10.0)
        return tid
    if op == "close_tab":
        h.close_tab(tab)
        return True
    if op == "shutdown":
        return True
    if not isinstance(tab, str) or not tab:
        raise ValueError("onglet manquant")
    h.switch_tab(tab)
    if op == "read_page":
        text = h.js("document.body ? document.body.innerText : ''")
        pw = h.js("document.querySelectorAll('input[type=password]').length")
        return {"text": text, "passwordFields": int(pw or 0)}
    if op == "navigate":
        h.goto_url(str(req["url"]))
        h.wait_for_load(10.0)
        return True
    sel = str(req.get("selector", ""))
    if op == "is_password_field":
        expr = ("(()=>{const e=document.querySelector(%s);if(!e)return 'absent';"
                "const t=(e.getAttribute('type')||'').toLowerCase();const a=(e.getAttribute('autocomplete')||'').toLowerCase();"
                "return (t==='password'||a.includes('password'))?'password':'other'})()") % js_str(sel)
        return h.js(expr) == "password"
    if op == "click":
        pos = h.js("(()=>{const e=document.querySelector(%s);if(!e)return null;e.scrollIntoView({block:'center'});"
                   "const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()" % js_str(sel))
        if not pos:
            raise ValueError("élément introuvable")
        h.click_at_xy(pos[0], pos[1])
        return True
    if op == "type_text":
        h.fill_input(sel, str(req.get("text", "")))
        return True
    if op == "press_key":
        key = KEYS.get(str(req.get("key", "")).lower())
        if not key:
            raise ValueError("touche non permise")
        h.press_key(key)
        return True
    raise ValueError("opération inconnue")


def main() -> None:
    try:
        req = json.loads(sys.stdin.read())
    except ValueError:
        refuse("requête illisible")
    op = req.get("op") if isinstance(req, dict) else None
    if op not in OPS:
        refuse("opération inconnue")
    name = sandbox_env()
    real_out = sys.stdout
    sys.stdout = io.StringIO()  # la bibliothèque peut écrire : seule notre ligne JSON sort
    try:
        from browser_harness import admin, helpers  # noqa: E402  (après la validation de l'environnement)

        if op == "shutdown":
            admin.restart_daemon(name)
            result: object = True
        else:
            admin.ensure_daemon(name=name)
            result = run(op, req, helpers)
        out = {"ok": True, "result": result}
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001
        out = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
    finally:
        sys.stdout = real_out
    real_out.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
