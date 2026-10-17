"""Sidecar UI Automation (pywinauto, backend UIA) : sept opérations, aucune exécution arbitraire.

Protocole : une ligne JSON par requête sur stdin {"id", "op", "args"}, une ligne JSON par réponse sur stdout
{"id", "ok", "result" | "error"}. Les opérations inconnues sont refusées. La politique (fenêtres permises, accord,
débit) est appliquée par l'hôte AVANT l'envoi : ce processus n'est qu'un exécutant.
"""
import json
import sys

from pywinauto import Desktop
from pywinauto.keyboard import send_keys

KEYS = {
    "enter": "{ENTER}", "tab": "{TAB}", "escape": "{ESC}", "up": "{UP}", "down": "{DOWN}", "left": "{LEFT}",
    "right": "{RIGHT}", "pageup": "{PGUP}", "pagedown": "{PGDN}", "home": "{HOME}", "end": "{END}",
}
desk = Desktop(backend="uia")
cache = {}


def windows():
    out = []
    for w in desk.windows():
        try:
            title = w.window_text()
            if not title:
                continue
            handle = str(w.handle)
            cache[handle] = w
            out.append({"id": handle, "title": title, "process": _proc(w)})
        except Exception:
            continue
    return out


def _proc(w):
    """Nom du processus propriétaire (ctypes, sans dépendance supplémentaire)."""
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.windll.kernel32
    handle = kernel.OpenProcess(0x1000, False, w.process_id())  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if kernel.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit("\\", 1)[-1]
        return ""
    finally:
        kernel.CloseHandle(handle)


def win(wid):
    w = cache.get(wid)
    if w is None:
        windows()
        w = cache.get(wid)
    if w is None:
        raise ValueError("fenêtre introuvable")
    return w


def elements(w, query):
    out = []
    for i, e in enumerate(w.descendants()):
        try:
            info = e.element_info
            name = info.name or ""
            aid = info.automation_id or ""
            ctype = info.control_type or ""
            if query.get("name") and query["name"].lower() not in name.lower():
                continue
            if query.get("automationId") and query["automationId"] != aid:
                continue
            if query.get("controlType") and query["controlType"] != ctype:
                continue
            eid = f"{aid or name or ctype}#{i}"
            cache[f"{w.handle}:{eid}"] = e
            out.append({"id": eid, "name": name, "controlType": ctype, "isPassword": _is_password(info)})
        except Exception:
            continue
    return out


def _is_password(info):
    try:
        return bool(info.element.CurrentIsPassword)
    except Exception:
        return False


def el(wid, eid):
    w = win(wid)
    e = cache.get(f"{w.handle}:{eid}")
    if e is None:
        elements(w, {})
        e = cache.get(f"{w.handle}:{eid}")
    if e is None:
        raise ValueError("élément introuvable")
    return e


def handle(op, a):
    if op == "list_windows":
        return windows()
    if op == "find_element":
        return elements(win(a["window"]), a)
    if op == "read_text":
        e = el(a["window"], a["element"])
        return e.window_text() or (e.get_value() if hasattr(e, "get_value") else "")
    if op == "click":
        el(a["window"], a["element"]).invoke() if hasattr(el(a["window"], a["element"]), "invoke") else el(a["window"], a["element"]).click_input()
        return None
    if op == "type_text":
        e = el(a["window"], a["element"])
        e.set_edit_text(a["text"]) if hasattr(e, "set_edit_text") else (e.set_focus(), send_keys(a["text"], with_spaces=True, pause=0.01))
        return None
    if op == "focus_window":
        win(a["window"]).set_focus()
        return None
    if op == "press_key":
        if a["key"] not in KEYS:
            raise ValueError("touche refusée")
        win(a["window"]).set_focus()
        send_keys(KEYS[a["key"]])
        return None
    raise ValueError("opération inconnue")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        res = {"id": req.get("id"), "ok": True, "result": handle(req.get("op"), req.get("args") or {})}
    except Exception as exc:  # noqa: BLE001
        res = {"id": req.get("id") if isinstance(locals().get("req"), dict) else None, "ok": False, "error": str(exc)[:200]}
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
