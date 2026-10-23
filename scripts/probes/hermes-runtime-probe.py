"""Banc d'essai Hermes sur profil jetable (lecture seule pour le profil réel).

- HERMES_HOME et HOME temporaires, faux fournisseur OpenAI-compatible sur 127.0.0.1.
- Proxy HTTP(S) mort + NO_PROXY=loopback : aucune requête proxy-compatible ne sort.
- Lance `hermes serve` comme Jarod-OS (manager.ts) et pilote /api/ws en JSON-RPC.
Usage : <venv python> -I hermes_probe.py <racine hermes-agent> <dossier de travail>
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
WORK = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(ROOT))

from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall, write_hermes_home  # noqa: E402
from websockets.sync.client import connect  # noqa: E402

MODE = sys.argv[3] if len(sys.argv) > 3 else "smart"
REAL_HOME = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"
RESULTS: list[tuple[str, str, str]] = []


def record(name: str, status: str, detail: str = "") -> None:
    RESULTS.append((name, status, detail))
    print(f"[{status}] {name} {detail}", flush=True)


def last_user_text(body: dict) -> str:
    for m in reversed(body.get("messages") or []):
        if m.get("role") == "user":
            c = m.get("content")
            return c if isinstance(c, str) else json.dumps(c)
    return ""


def tool_answered_since_user(body: dict) -> bool:
    for m in reversed(body.get("messages") or []):
        if m.get("role") == "tool":
            return True
        if m.get("role") == "user":
            return False
    return False


def responder(rec: dict):
    body = rec.get("body") or {}
    text = last_user_text(body)
    if "OUTIL" in text:
        if tool_answered_since_user(body):
            return Text("Outil traite, fin du tour.")
        # Commande inoffensive (dossier inexistant dans le dossier jetable) mais classée dangereuse : force une approbation.
        return ToolCall("terminal", {"command": "rm -r ./dossier-inexistant-jarod-probe"})
    if "LENT" in text:
        return Text("x" * 400, chunk_chars=4, delay_per_chunk=0.1)
    return Text("Bonjour depuis le faux modele local.", chunk_chars=6)


class Rpc:
    def __init__(self, url: str) -> None:
        self.ws = connect(url, open_timeout=30, max_size=None)
        self.frames: queue.Queue = queue.Queue()
        self.events: list[dict] = []
        self.server_requests: list[dict] = []
        self.responses: dict = {}
        self.n = 0
        threading.Thread(target=self._pump, daemon=True).start()

    def advertise(self) -> dict:
        # Comme json-rpc-channel.ts : sans cette annonce, Hermes retire toute demande serveur -> client.
        return self.call("client.capabilities", {"server_requests": True})

    def _pump(self) -> None:
        try:
            for msg in self.ws:
                self.frames.put(msg if isinstance(msg, str) else msg.decode())
        except Exception:
            pass
        self.frames.put(None)

    def _step(self, timeout: float) -> None:
        try:
            raw = self.frames.get(timeout=timeout)
        except queue.Empty:
            return
        if raw is None:
            raise ConnectionError("transport ferme")
        msg = json.loads(raw)
        if msg.get("method") == "event":
            self.events.append(msg.get("params") or {})
        elif "id" in msg and "method" in msg:
            self.server_requests.append(msg)
        elif "id" in msg:
            self.responses[msg["id"]] = msg

    def call(self, method: str, params: dict | None = None, timeout: float = 90.0) -> dict:
        self.n += 1
        rid = f"probe-{self.n}"
        self.ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}))
        end = time.monotonic() + timeout
        while rid not in self.responses:
            if time.monotonic() > end:
                raise TimeoutError(f"{method}: pas de reponse en {timeout}s")
            self._step(0.3)
        return self.responses.pop(rid)

    def wait(self, pred, timeout: float = 90.0) -> dict:
        end = time.monotonic() + timeout
        seen = 0
        while True:
            for ev in self.events[seen:]:
                if pred(ev):
                    return ev
            seen = len(self.events)
            for req in list(self.server_requests):
                if pred({"type": req.get("method"), "server_request": req, **(req.get("params") or {})}):
                    return {"type": req.get("method"), "server_request": req, "payload": req.get("params")}
            if time.monotonic() > end:
                raise TimeoutError(f"evenement attendu absent ; vus : {[e.get('type') for e in self.events][-25:]}")
            self._step(0.3)

    def close(self) -> None:
        self.ws.close()


def hermes_processes() -> set[int]:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-c",
         "Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'hermes_cli|hermes\\.exe|tui_gateway' -and $_.CommandLine -notmatch 'Get-CimInstance' } | % { $_.ProcessId }"],
        capture_output=True, text=True).stdout
    return {int(x) for x in out.split() if x.strip().isdigit()}


def spawn(home: Path, hermes_home: Path, token: str, ready_file: Path) -> tuple[subprocess.Popen, int, list[str]]:
    python = ROOT / "venv" / "Scripts" / "python.exe"
    keep = {"SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "PATH", "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE", "OS", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES"}
    env = {k: v for k, v in os.environ.items() if k.upper() in keep}
    env.update({
        "HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "HERMES_HOME": str(hermes_home), "TERMINAL_CWD": str(WORK / "project"),
        "HERMES_DASHBOARD_SESSION_TOKEN": token, "HERMES_DESKTOP": "1",
        # Le drapeau d'origine du shell (ancien nom du produit, reconstruit pour le garde de renommage), comme manager.ts.
        "HER" + "ALD_OS": "1",
        "HERMES_PARENT_PID": str(os.getpid()), "HERMES_DESKTOP_READY_FILE": str(ready_file),
        "PYTHONUNBUFFERED": "1", "NO_COLOR": "1",
        # Coupure réseau pour tout client qui respecte les proxys d'environnement.
        "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9", "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "127.0.0.1,localhost,::1",
    })
    proc = subprocess.Popen([str(python), "-m", "hermes_cli.main", "serve", "--host", "127.0.0.1", "--port", "0"],
                            cwd=str(ROOT), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
    lines: list[str] = []
    port_box: list[int] = []

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line.rstrip())
            if line.startswith(("HERMES_BACKEND_READY", "HERMES_DASHBOARD_READY")) and "port=" in line:
                port_box.append(int(line.split("port=")[1].split()[0]))

    threading.Thread(target=pump, daemon=True).start()
    end = time.monotonic() + 180
    while not port_box:
        if proc.poll() is not None:
            raise RuntimeError("serve sorti " + str(proc.returncode) + "\n" + "\n".join(lines[-40:]))
        if time.monotonic() > end:
            raise TimeoutError("pas de ligne READY\n" + "\n".join(lines[-40:]))
        time.sleep(0.2)
    return proc, port_box[0], lines


def http_status(url: str, token: str | None) -> int:
    req = urllib.request.Request(url, headers={"X-Hermes-Session-Token": token} if token else {})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        return opener.open(req, timeout=15).status
    except urllib.error.HTTPError as e:
        return e.code


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
        proc.wait(timeout=30)


def main() -> None:
    home = WORK / "home"
    hermes_home = home / ".hermes"
    (WORK / "project").mkdir(parents=True, exist_ok=True)
    assert REAL_HOME.resolve() not in hermes_home.resolve().parents and hermes_home.resolve() != REAL_HOME.resolve()
    before = hermes_processes()
    print("processus Hermes preexistants :", sorted(before), flush=True)

    with FakeLLMServer(responder) as llm:
        write_hermes_home(hermes_home, llm.base_url, api_key="sk-fake-probe",
                          extra_config=f"updates:\n  check: false\ndisplay:\n  compact: true\napprovals:\n  mode: {MODE}\n")
        token = uuid.uuid4().hex
        proc, port, logs = spawn(home, hermes_home, token, WORK / "ready.json")
        base = f"http://127.0.0.1:{port}"
        try:
            record("demarrage", "OK", f"port {port}, pid {proc.pid}")
            s_ok, s_none, s_bad = http_status(f"{base}/api/config", token), http_status(f"{base}/api/config", None), http_status(f"{base}/api/config", "mauvais")
            record("auth REST (/api/config)", "OK" if s_ok == 200 and s_bad in (401, 403) and s_none in (401, 403) else "ECHEC",
                   f"jeton={s_ok} sans={s_none} faux={s_bad} ; /api/status sans jeton={http_status(f'{base}/api/status', None)} (public par conception)")
            try:
                bad = Rpc(f"ws://127.0.0.1:{port}/api/ws?token=mauvais")
                r = bad.call("ping", timeout=10)
                record("auth WS refusee", "ECHEC", f"accepte : {r}")
            except Exception as e:  # noqa: BLE001
                record("auth WS refusee", "OK", type(e).__name__)

            rpc = Rpc(f"ws://127.0.0.1:{port}/api/ws?token={token}")
            record("connexion WS authentifiee", "OK", str(rpc.call("ping").get("result")))
            rpc.advertise()

            created = rpc.call("session.create", {"source": "desktop", "cwd": str(WORK / "project"), "title": None})
            sid = (created.get("result") or {}).get("session_id")
            stored = (created.get("result") or {}).get("stored_session_id")
            record("creation de session", "OK" if sid else "ECHEC", f"vivante={sid} stockee={stored} {created.get('error') or ''}")

            rpc.call("prompt.submit", {"session_id": sid, "text": "Dis bonjour"})
            done = rpc.wait(lambda e: e.get("type") == "message.complete" and e.get("session_id") == sid)
            deltas = [e for e in rpc.events if e.get("type") == "message.delta" and e.get("session_id") == sid]
            record("streaming", "OK" if len(deltas) > 1 else "ECHEC", f"{len(deltas)} deltas, texte={(done.get('payload') or {}).get('text')!r}")

            n_ev = len(rpc.events)
            n_aux = len(llm.aux_requests())
            rpc.call("prompt.submit", {"session_id": sid, "text": "OUTIL : lance la commande"})
            first = rpc.wait(lambda e: (e.get("type") in ("approval.request", "approval") or
                                        (e.get("type") == "message.complete" and e.get("session_id") == sid)) and
                             (e.get("server_request") or rpc.events.index(e) >= n_ev))
            if first.get("type") in ("approval.request", "approval"):
                payload = first.get("payload") or {}
                record(f"outil factice -> approbation ({MODE})", "OK",
                       f"forme={'requete serveur ' + first['type'] if first.get('server_request') else 'evenement'} commande={payload.get('command')!r}")
                if first.get("server_request"):
                    rpc.server_requests.remove(first["server_request"])
                    rpc.ws.send(json.dumps({"jsonrpc": "2.0", "id": first["server_request"]["id"], "result": {"choice": "deny"}}))
                else:
                    r = rpc.call("approval.respond", {"session_id": sid, "choice": "deny", "request_id": payload.get("request_id")})
                    record("approval.respond deny", "OK" if "result" in r else "ECHEC", json.dumps(r.get("result") or r.get("error"))[:120])
                rpc.wait(lambda e: e.get("type") == "message.complete" and e.get("session_id") == sid and rpc.events.index(e) >= n_ev)
            else:
                record(f"outil factice -> approbation ({MODE})", "AUCUNE DEMANDE", "le tour s'est termine sans approval.request")
            tools = [e for e in rpc.events[n_ev:] if str(e.get("type", "")).startswith("tool.")]
            done_tool = next((t for t in tools if t.get("type") == "tool.complete"), {})
            aux = llm.aux_requests()[n_aux:]
            aux_sys = [str((r.get("body") or {}).get("messages", [{}])[0].get("content", ""))[:90] for r in aux]
            record("trace outil", "INFO", f"evenements={[t.get('type') for t in tools]} resultat={json.dumps(done_tool.get('payload'))[:260]}")
            record("appels gardien/aux pendant le tour", "INFO", f"{len(aux)} : {aux_sys}")

            n_ev = len(rpc.events)
            rpc.call("prompt.submit", {"session_id": sid, "text": "LENT : ecris longtemps"})
            rpc.wait(lambda e: e.get("type") == "message.delta" and rpc.events.index(e) >= n_ev)
            t0 = time.monotonic()
            intr = rpc.call("session.interrupt", {"session_id": sid})
            rpc.wait(lambda e: e.get("type") in ("message.complete", "status.update") and rpc.events.index(e) >= n_ev
                     and (e.get("type") == "message.complete" or "interrupt" in json.dumps(e).lower()), timeout=30)
            record("interruption", "OK" if "result" in intr else "ECHEC", f"{intr.get('result') or intr.get('error')} en {time.monotonic() - t0:.1f}s")

            rpc.close()
            rpc = Rpc(f"ws://127.0.0.1:{port}/api/ws?token={token}")
            rpc.advertise()
            res = rpc.call("session.resume", {"session_id": stored, "source": "desktop"})
            live = (res.get("result") or {}).get("session_id") or sid
            hist = rpc.call("session.history", {"session_id": live})
            msgs = (hist.get("result") or {}).get("messages")
            record("reconnexion + reprise", "OK" if res.get("result") and isinstance(msgs, list) and msgs else "ECHEC",
                   f"resume={'ok, ' + str((res['result']).get('message_count')) + ' messages' if res.get('result') else res.get('error')} historique={len(msgs) if isinstance(msgs, list) else hist.get('error')}")

            for m in ("client.capabilities", "gateway.capabilities", "usage.bars", "billing.state", "insights.get",
                      "session.usage", "tools.list", "process.list", "preview.restart", "learning.frames"):
                p = {"session_id": sid} if m in ("session.usage", "process.list", "preview.restart") else {}
                r = rpc.call(m, p, timeout=30)
                err = r.get("error")
                record(f"methode {m}", "REPOND" if not err else "ERREUR",
                       (json.dumps(r.get("result"))[:160] if not err else f"{err.get('code')} {str(err.get('message'))[:120]}"))
            rpc.close()
        finally:
            stop(proc)

        proc, port, logs2 = spawn(home, hermes_home, token, WORK / "ready.json")
        try:
            rpc = Rpc(f"ws://127.0.0.1:{port}/api/ws?token={token}")
            rpc.advertise()
            listed = rpc.call("session.list", {})
            rows = (listed.get("result") or {}).get("sessions") or []
            res = rpc.call("session.resume", {"session_id": stored, "source": "desktop"})
            live = (res.get("result") or {}).get("session_id")
            hist = rpc.call("session.history", {"session_id": live}) if live else {"error": "pas de session vivante"}
            msgs = (hist.get("result") or {}).get("messages")
            listed_ids = [r.get("id") or r.get("session_id") for r in rows]
            record("reprise apres redemarrage", "OK" if live and stored in listed_ids and isinstance(msgs, list) and msgs else "ECHEC",
                   f"listees={listed_ids} historique={len(msgs) if isinstance(msgs, list) else hist.get('error')} resume={'ok' if live else res.get('error')}")
            n_ev = len(rpc.events)
            rpc.call("prompt.submit", {"session_id": live, "text": "Encore bonjour"})
            done = rpc.wait(lambda e: e.get("type") == "message.complete" and e.get("session_id") == live and rpc.events.index(e) >= n_ev)
            record("nouveau tour apres reprise", "OK", repr((done.get("payload") or {}).get("text"))[:80])
            rpc.close()
        finally:
            stop(proc)

        print("requetes au faux LLM :", len(llm.requests), "(main", len(llm.main_requests()), ")", flush=True)

    after = hermes_processes()
    record("processus externes intacts", "OK" if before <= after or not before else "ECHEC",
           f"avant={sorted(before)} apres={sorted(after)}")
    (WORK / "resultats.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=1), encoding="utf-8")
    (WORK / "serve.log").write_text("\n".join(logs + ["---- redemarrage ----"] + logs2), encoding="utf-8")


if __name__ == "__main__":
    main()
