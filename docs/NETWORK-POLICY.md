# Internet switch

The top bar of Jarod-OS has a pill: **Internet activé** (a globe) or **Internet désactivé** (red). A click opens its details.

The switch is **Jarod's policy, not a disconnection**. It decides what Jarod-OS and its core may reach. Windows and other programs keep their network: the network card and the Windows firewall are never touched.

## The file

The switch is stored in `network-policy.json`, in the shell's config folder (`%APPDATA%\Jarod-OS\config`, or `JAROD_OS_CONFIG_DIR`):

```json
{ "version": 1, "internet": false, "remoteMachines": true, "remoteHosts": ["100.64.0.7"], "localCommands": false }
```

| Situation | Reading |
|---|---|
| No file (first start) | Internet on. The shell writes the file at once, so the core finds it. |
| Unreadable or invalid file | **Internet off**, with no exception. The file is left as it is, for inspection. |
| The core finds no file while `JAROD_NETWORK_POLICY` names one | Internet off. |
| Nothing turns the Internet back on by itself | Neither a restart, nor an error, nor the agent: the setting can be changed only from the shell's UI, and no OS command or agent tool reaches it. |

## Where it is enforced

| Way out | Mechanism | File |
|---|---|---|
| The shell's web sessions: main window, right pane, Browser, viewers, agent browser, `net.fetch` | Every session (present and future, `session-created`) takes a proxy pointing to `127.0.0.1:9`, where nothing listens. A request fails at once, and Chromium never falls back to a direct connection. Loopback is always bypassed. Open connections are closed (`closeAllConnections`) when the switch goes off. | `electron/ipc/network.ts`, `electron/network.ts` |
| WebRTC (UDP, which ignores proxies) | `disable_non_proxied_udp` on every page while the switch is off; each page's previous policy comes back when it is on again | `electron/ipc/network.ts` |
| The shell's Node sockets (fetch, http, tls, WebSocket) | Guard on `net.Socket.prototype.connect`. A refused connection fails before any byte is sent, with the code `JAROD_OFFLINE`. Connections already open to a host that is no longer allowed are closed. | `electron/net-guard.ts` |
| The shell's and the core's resolver and UDP (since V-05) | Direct resolver calls (`dns.lookup`, `dns.resolve*`, `dns.promises`, `Resolver`, named imports included) and `dgram` `send`/`connect` are judged by the same rule; a refusal never reaches the network. | `electron/net-guard.ts`, `kernel/src/network.ts` |
| Children while the switch is off (since V-05) | Dead proxy in the child's environment (`HTTP(S)_PROXY`, `ALL_PROXY`, `NODE_USE_ENV_PROXY`), loopback and allowed remote machines bypassed: a layer for programs that follow proxy variables (see Limits). | `kernel/src/child-env.ts` |
| The core's sockets: cloud models, messaging, MCP over HTTP, voice providers, OAuth | Same guard in the core's process. The file is checked on every connection (a `stat`; it is read again only when it changed), and watched so that open connections are closed when it changes. | `jarod-core/packages/kernel/src/network.ts`, `gateway/main.ts` |
| The core started without the shell: `jarod serve` (the autonomous daemon), `jarod ask`, `jarod mcp`, the ACP agent | The same file and the same guard, applied **before** `main()` opens the core (so before the first provider, gateway or MCP connection). The file is `JAROD_NETWORK_POLICY` if set, else `network-policy.json` in `JAROD_OS_CONFIG_DIR`, else the installed shell's `%APPDATA%\Jarod-OS\config`. **No file found = no switch configured: Internet allowed, as before.** A file that is found but unreadable = Internet off. | `kernel/src/network.ts` (`resolvePolicyFile`, `applyNetworkPolicyForEntry`), `cli/src/main.ts` |
| Agent tools | The single tool gate (`executeGuardedTool`) refuses, before any approval request: `web_search`, `web_fetch`, `http_request`, `browser_*`, `connected_browser`, and the downloads of skills and Pinokio. The refusal is recorded in the audit log. | `agent.ts`, `toolVerdict` |
| Programs Jarod cannot cut off from the network: `run_shell`, MCP servers | Refused while the switch is off, unless the person enables **Autoriser les commandes locales**. That exception does not isolate them: it is the person's informed choice. | `toolVerdict` |
| Programs the shell launches | Python environments: `uv --offline`, so only a Python already on the machine works. Node.js: refused. `wsl --install` and `--list --online`: refused. winget installs (setup audit), the confirmed winget upgrade of Système › Mises à jour, and catalog installs: refused. | `ipc/environments.ts`, `ipc/vms.ts`, `ipc/system-audit.ts`, `ipc/catalog.ts`, `winget-install.ts` |

## What stays allowed

- Loopback (`localhost`, `127.0.0.0/8`, `::1`):
  - local models (LM Studio, Ollama, llama-server);
  - the core's gateway;
  - Pinokio;
  - local services.
- Files, memory and local tools.
- **Autoriser les machines distantes configurées**: while the switch is off, the remote machines listed in `remoteHosts` stay reachable. The list is filled from Connexions › Machines distantes. The pill then reads **Internet bloqué — accès distant autorisé**. No private network is allowed implicitly: a LAN or Tailscale address that is not listed stays blocked.
  - A Tailscale link can itself need the Internet underneath, for coordination or relays. That traffic belongs to Tailscale's service, not to Jarod.

## Requests in progress

When the switch goes off:

- Chromium connections are closed.
- Node sockets (shell and core) to hosts that are no longer allowed are destroyed. A streaming model answer then stops with an error.
- Nothing is replayed when the switch comes back on.
- What was already sent cannot be recalled, and the panel says so.

## Models

A cloud model selected while the switch is off becomes unavailable:

- the model button turns orange and explains why;
- the menu lists local models first, and the cloud models are marked "hors ligne" and cannot be chosen;
- Jarod never switches provider silently.

## Limits, stated plainly

- **DNS** (corrected on 2026-10-23, V-05). Measured: a connection refused at `connect` is refused **before** any name lookup (`net.connect` or `fetch` to a host name resolve nothing). What used to leave was a **direct** resolver call (`dns.lookup`, `dns.resolve*`, `dns.promises`, `Resolver`): it is now judged by the same rule, in the core and in the shell, and fails with `JAROD_OFFLINE` without a query. Loopback names still resolve. The system's own resolver (Windows, browsers outside Jarod) is not Jarod's.
- **UDP sockets** (`dgram`), corrected on 2026-10-23 (V-05): every `send` and `connect` is judged by the same rule, in the core and in the shell. A connected socket is judged again on every send, so switching off also stops it. Loopback stays allowed.
- **Child processes**, three levels, stated plainly:
  - **Confined commands** (`run_shell` under `jarod-sandbox`): an AppContainer with **no network capability**. The Windows kernel refuses the connection (`EACCES`), whatever the program does; proved by `agent/test/sandbox-network.test.ts` (on demand, it touches a public address).
  - **Every other child** (unconfined `run_shell`, MCP servers, engines) while the switch is off: since V-05 `childEnv` gives it `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (both cases) pointing to the dead proxy `127.0.0.1:9`, `NO_PROXY` for loopback and the allowed remote machines, and `NODE_USE_ENV_PROXY=1`. Programs that follow proxy variables (curl, git, pip, npm, Python, Go, Node 24 including the Node bundled in Electron 44) fail at once. **This is a layer, not an isolation**: a program that ignores these variables still opens its own connections.
  - That is why the policy still **refuses to launch** `run_shell` and MCP servers while the switch is off, unless the person enables **Autoriser les commandes locales**. Kernel-level isolation of any program would need a firewall rule per program, which needs elevation; Jarod does not set it without explicit permission.
- **Hermes** (alternative backend): the guard is in the Jarod core. With `JAROD_OS_BACKEND=hermes`, only the shell's layers apply.

## Tests

| Test | What it covers |
|---|---|
| `apps/desktop/electron/network.test.ts` | Policy reading; decision; proxy; persistence; refusals; the socket guard on Node `fetch`; closing an open connection |
| `jarod-core/packages/kernel/test/network.test.ts` | The same cases on the core's side, plus the reader that follows the file, plus the resolver and UDP guard (V-05) |
| `jarod-core/packages/kernel/test/child-env.test.ts` | The dead proxy given to children while the switch is off, and a real Node child failing at once through it (V-05) |
| `jarod-core/packages/kernel/test/network-entry.test.ts` | The standalone entry points: where the file is found, the guard applied before the first connection, an unreadable file read as "off", a rewritten file taking effect, and the start-up order of the binary |
| `jarod-core/packages/plugins/agent/test/offline-gate.test.ts` | Refusal before any approval request, with an audit line |
| `apps/desktop/e2e/cockpit.spec.ts` | The real app: the switch, a request from the window refused, the file written for the core, the setting kept after a restart |
