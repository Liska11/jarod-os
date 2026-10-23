# Secrets outside the chat

Réglages › **Secrets** is where you give Jarod credentials (API keys, tokens, passwords) without typing them in the conversation.

This builds on the core's existing vault. No second vault was created: the same `VaultService` is used by the agent tools, and the core already had native confirmation dialogs.

## What the screen does

| Feature | Detail |
|---|---|
| Form | Masked field. Fields: name (what the agent calls it), **type** (API key, token, password, other), description, domains it may be sent to, environment variable, use in shell commands. |
| Add, replace | Leave the value empty to keep the stored one. |
| Delete | Native confirmation; the value is erased. |
| **Revoke** | Removes every reach (domains and shell) without erasing the value. Restricting asks for nothing. |
| Widening the reach | Adding a domain or allowing the shell is confirmed by a native dialog that names what changes. |
| **Temporary** | The entry and its value stay in the core's memory only, for the current run: never in the settings, never in the `secrets` table, so never on disk or in a backup. They are gone at the next start. A secret never switches between temporary and stored. |
| Protection status | Shown at the top of the screen (`vault-status`), read from what the core's storage really did when it opened the database (`dbEncryption.keyStoreId`: the store that gave the key back), never guessed from the files on disk nor in the screen. Four states: **DPAPI** (normal: database encrypted, key protected by the Windows account); **weak** (warning: DPAPI could not keep the key, so it is in `db.key` beside the database; the screen says to keep the folder to the Windows account, not to copy it, and how to go back to DPAPI: full backup, then restore into a new profile, where the key is handed to DPAPI); **clear** (database not encrypted); **unknown** (the core did not answer, an older core, or an unrecognised store: nothing is assumed). Neither the key nor a value is in the answer. Tests: `bridge/test/vault.test.ts`, `storage/test/encryption.test.ts`, `vault-model.test.ts`, e2e `e2e/vault-protection.spec.ts` (DPAPI and key-file profiles, throwaway). |

## How the agent uses a secret

- **It knows names, never values.** `vault_list` returns names, purpose and allowed domains.
- **The value goes in at the last moment, in the backend.**
  - `http_request`: the `{{secret:NAME}}` placeholder is filled only over https, and only towards an allowed domain (`fillRequest`).
  - `run_shell`: the value is passed as an environment variable, only if the secret allows the shell.
  - What comes back is masked: `[secret:NAME]`, including the URL-encoded and base64 forms.
- **There is no generic tool that reads all the secrets.** A request typed in the chat cannot widen a secret's reach: only the screen can, behind a native confirmation.
- **`http_request` is marked dangerous:** the person approves each call.
- **The Internet switch applies too** (`docs/NETWORK-POLICY.md`). While the Internet is off, `http_request` is refused before it can carry anything.

## Exclusions

| Where | How the values are kept out |
|---|---|
| Conversations and summaries | The values never reach the model; tool outputs are masked. |
| Memory and embeddings | Built from the conversation, which does not hold the values. |
| Logs and audit | The arguments of a tool call are masked **by structure** before they are written (`auditArgs`, `kernel/src/redact.ts`): a field named like a secret (`password`, `token`, `apiKey`, `authorization`, `cookie`…) is replaced whole, short or long; strings go through the known token shapes and the `--password abc`-style command-line options; truncation comes last. Free text holding an unknown, unnamed secret is not guaranteed to be caught. Older logs are not rewritten: if an old log may hold a pasted secret, rotate that secret. |
| External backups | The values are deleted from the database copy (`docs/BACKUP-EXTERNE.md`). A temporary secret is never on disk. |
| Local backups of the Jarod disk | They copy the encrypted database as it is, values included. They live on the same disk, under the same protection as the data. |

## What a child process receives (2026-10-22)

The core builds each child's environment instead of passing its own (`kernel/src/child-env.ts`):

| Child | Receives | Never receives |
|---|---|---|
| A third-party **MCP server** | The system environment (Windows needs `PATH`, `SystemRoot`, `TEMP`, `APPDATA`…; `ELECTRON_RUN_AS_NODE` stays) and **only the variables its own configuration names** (an internal control token named there is still dropped) | Internal control tokens, Jarod's provider keys, and any variable whose name looks like a secret (token, password, API key…) unless the server's configuration names it |
| A command of the agent (`run_shell`, `system_open`) | The person's environment, so `git`, `aws`, `kubectl`, `ssh`, `docker` keep working with their own credentials, plus the secrets the vault injects for that one command | Internal control tokens (gateway, control channel, relays, messaging) and Jarod's provider keys |
| An engine Jarod launches (syft, PowerShell tools, browser, embeddings…) | As the agent's | As the agent's |

The gateway token is read at start-up and removed from the core's own environment before any child can exist. The chain "MCP server → control token → core → sensitive read" is cut at its first link: a server has no token to present. Possessing a token would not, by itself, give access to every API; this was not tested with a real token.

## Limits

- A secret used to sign in is **sent to its recipient**: Jarod controls only where it goes.
- Masking is not the only barrier, and it does not protect against a Windows that is already compromised.
- If the person types a secret in the chat themselves, nothing stops them. The screen exists so they don't have to.
- **Remote machines (SSH)**: authentication uses a key file or the SSH agent (`docs/REMOTE-SSH.md`). No password goes through the vault for SSH in this version.

## Tests

| Test | What it covers |
|---|---|
| `jarod-core/packages/bridge/test/vault.test.ts` | The value never goes back to the screen; widening needs confirmation; temporary values written nowhere; revocation without erasing; protection status |
| `jarod-core/packages/plugins/agent/test/vault.test.ts` | Domains, https, masking |
| `apps/desktop/src/features/settings/sections/vault-model.test.ts` | The form |
| `apps/desktop/e2e/external-backup.spec.ts` | A fake secret entered in the screen does not appear in the backup |
