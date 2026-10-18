# Remote machines: Tailscale and SSH

**Connexions › Machines distantes** finds your other PC and opens an SSH terminal on it, from inside Jarod-OS.

| Code | Role |
|---|---|
| `electron/remote-machines.ts` | Tailscale, network test, host keys |
| `electron/ipc/remote-machines.ts` | The screen's calls |
| `electron/ipc/terminal.ts` (`remoteCommand`) | The SSH terminal |
| `src/features/connections/RemoteMachines.tsx` | The screen |
| `jarod-core/.../tools/src/remote-exec.ts` | The agent's `remote_exec` tool: one confirmed command at a time |
| `src/features/settings/sections/DevicesSection.tsx` | Réglages › Appareils: the per-machine switch for agent commands |

The SSH targets are the core's existing ones (`ssh-hosts-*`, `tools/ssh-hosts.ts`), also listed in Réglages › Appareils.

## What is really used

- **Tailscale.** Its state and its machines are read with `tailscale status --json`, from the Tailscale service already installed on this computer.
  - Jarod **installs nothing, connects no account, and never changes the ACLs**.
  - If Tailscale is not connected, the screen says so and asks you to start it from its own icon.
- **Plain SSH (OpenSSH, `C:\Windows\System32\OpenSSH`) to the machine's address**, for example its Tailscale address (`100.x.y.z`).
  - **Tailscale SSH is not used**: the screen only shows whether a machine offers it.
- **Authentication.**
  - A **private key chosen in the native "Ouvrir" dialog**: its path is never typed, its content never read.
  - Or the system's SSH agent.
  - No password, no passphrase: the core enforces `BatchMode=yes` and `PreferredAuthentications=publickey`.

## Three separate checks

| Check | What it does | What it proves |
|---|---|---|
| **Network** | A TCP connection to `host:port`, closed at once; nothing is sent | That something is listening (an error, a timeout or a block by the Internet switch is named) |
| **Host key** | `ssh-keyscan`, then `ssh-keygen -lf`: SHA256 fingerprints compared with `~/.ssh/known_hosts` (hashed entries included) | Known, unknown, **changed** or unreachable |
| **Sign-in** | The core's fixed test command (`id`, `hostname`, `uname`), with host-key checking enforced (`StrictHostKeyChecking=yes`) | That the key opens a session |

## Trusting a host key

**First time.** The fingerprints are shown, with a request to compare them with the machine's own. The key goes into `known_hosts` only after **Faire confiance**.

**Changed key.** Old and new fingerprints are shown side by side, with a warning about interception. The swap happens only after **Remplacer la clé**:

- `ssh-keygen -R` keeps a `known_hosts.old` copy;
- only the lines scanned by main in that session are written, under a one-time token, so the screen cannot supply a key of its own.

**Verification is never turned off globally.** The core refuses `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null` (`assertHostKeyVerificationKept`).

## Terminal

**Terminal** opens a tab named "<alias> (distant)", running this command:

```
ssh -o StrictHostKeyChecking=yes -p <port> [-i <key> -o IdentitiesOnly=yes] -- <user>@<host>
```

- **Host and user are checked**: no space, no leading dash. The `--` prevents an option slipping in through them.
- **An unknown key makes the connection fail.** Trust it first with **Clé d'hôte**.
- **The session belongs to the person.** Timeouts and cancelling are SSH's own; closing the tab ends it.

## Agent commands (`remote_exec`)

The agent can run a command on a remote machine, **one command at a time, each only after you confirm it.**

**Off by default.** Turn it on per machine in **Réglages › Appareils**, with the switch on the machine's row.

- Turning it on opens a native confirmation that names the machine (`user@host:port`). Turning it off is immediate.
- Removing a machine also removes its permission; a later machine never inherits it.
- The list (`sshExecHosts` in the core's settings) has no other writer: the generic settings screen, a settings import and the model cannot set it.
- **While no machine is enabled, the tool is not offered to the model at all** (not in its list, not in `tool_search`). It is also not offered when the control journal is unavailable (outside the Jarod-OS desktop).

**Each call, in this order, before anything connects:**

1. The machine is a declared host, enabled for agent commands.
2. The command is plain text, at most 4,000 characters. Carriage returns, escape sequences, other control characters, zero-width and bidirectional characters are refused: what you read must be exactly what runs. Tabs and newlines are allowed.
3. The **Internet switch** lets this host through: Internet on, or the machine is listed with **Autoriser les machines distantes configurées** on. Otherwise refused.
4. The machine's **host key is already trusted** (`ssh-keygen -F` finds it in `known_hosts`). Otherwise refused: trust it first with **Clé d'hôte**.
5. **Your confirmation.** The card shows the machine and the command, verbatim and whole. Choices: **Autoriser une fois** or **Refuser**.
   - No "always allow" and no "for this conversation". The automatic approval of Réglages › Agent does not apply either.
   - Each command is asked separately. No answer within the approval delay is a refusal.
6. After your answer, steps 1 and 3 are checked again (they may have changed while the card was open).

**Then exactly the string you approved runs**, as the last argument of one `ssh` process:

```
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes … -o RequestTTY=no -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o Tunnel=no -i <key> -p <port> <user>@<host> <command>
```

- **No interactive session and no forwarding**: no terminal, stdin closed, every port forwarding cleared (including any from `ssh_config`), no agent or X11 forwarding.
- **Timeout**: 60 s by default, 300 s at most (`timeout_seconds`). Past it the process is killed.
- **Output cap**: 20,000 characters of stdout and of stderr each; the rest is read and dropped, and the result says it was cut.
- The output goes back to the model between markers that say it is data, not instructions.

**Control journal.** Every attempt goes to the shell's `control-audit.jsonl` (the core gets its path in `JAROD_CONTROL_JOURNAL`), in the same line shape (`client: backend`, `cmd: remote-exec`, `tier: destructive`, `source: agent`):

| Line | `code` | Also written |
|---|---|---|
| Refusal before or at the confirmation | `refused-disabled`, `refused-unknown-machine`, `refused-invalid`, `refused-offline`, `refused-host-key`, `approval-denied`… | machine, target, command |
| Approval | `approved` | machine, target, command |
| Result | `ok`, `exit`, `timeout`, `connection`… | exit code, duration |

- The command is written redacted (known token shapes masked) and clipped to 2,000 characters. The control token never appears.
- **No record, no run:** if the approval line cannot be written, the command does not run.
- The same request id ties the approval and its result.

## Internet switch (`docs/NETWORK-POLICY.md`)

- **The list of declared addresses feeds the switch's exception**: **Autoriser les machines distantes configurées**.
- **While the Internet is off**, the network test, the key reading and the SSH terminal are allowed only for a listed machine, and only with that exception on. Otherwise they are refused, with the reason.
- **No private network is allowed implicitly.**
- **Through an SSH shell, the remote machine has its own Internet access.**
  - Jarod does not control it, and does not claim to.
  - Neither for your terminal nor for an approved agent command: what the command does once on the machine is between you and that machine.
- **A Tailscale link can itself need the Internet** underneath, for coordination or relays.

## Tests

| Test | What it covers |
|---|---|
| `electron/remote-machines.test.ts` | Tailscale running and stopped; keyscan lines; fingerprints; known, new and changed keys, with the real `ssh-keygen` on a temporary `known_hosts`; TCP test; SSH command (options refused, strict checking); Internet switch |
| `e2e/cockpit.spec.ts` | The tab in the real app, against this machine's real Tailscale state (installed, not connected: `NoState`) |
| Core (`tools/test`) | Host-key checking, argv as an array |
| Core (`tools/test/remote-exec.test.ts`, simulated SSH transport) | Off by default (not offered), refusal, approval runs exactly the shown command, untrusted host, Internet switch (before and after the answer), timeout, output cap (also on a real local child process), journal lines and an unwritable journal |
| Bridge (`bridge/test/ssh-hosts.test.ts`) | The per-machine switch: native confirmation, refusal, off at once |
| Gateway (`cli/test/gateway-protocol.test.ts`) | The approval card carries the command verbatim, with "once" and "deny" only |

**Not tested for real:** a connection to your other PC (none was available), so no agent command has run on a real remote machine; and a running Tailscale with peers.
