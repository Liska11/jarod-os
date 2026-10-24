# Checking for updates

**Système › Mises à jour** has a "Vérifier les mises à jour" button.

| Code | Role |
|---|---|
| `electron/updates-check.ts` | The checks |
| `electron/ipc/updates-check.ts` | The screen's calls |
| `electron/winget-install.ts` | Upgrading one listed winget package |
| `src/features/system/UpdatesPanel.tsx` | The panel |

## Sources (official only)

| Category | Mechanism | Read-only? |
|---|---|---|
| Windows | Windows Update Agent API (`Microsoft.Update.Session` → `CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")`), type 1 | Yes. The script never builds a downloader or an installer; a test checks this. |
| Drivers | The same search, type 2 (Windows Update drivers) | Yes |
| Software | `winget upgrade --include-unknown --disable-interactivity` (lists without installing) | Yes. winget may refresh its source index. |

Each category shows one status:

- **À jour**;
- **N disponible(s)**, each with its name, KB / driver model / winget id, versions (current → available for winget, the driver date for Windows Update), source, **administrator rights** and **possible restart** (`RebootBehavior`);
- **Échec**, with the reason;
- **Non pris en charge** (winget missing);
- **Non vérifié**.

## What is not covered (shown under the results)

- Drivers that Windows Update does not offer: OEM tools, graphics drivers installed separately.
- Software that winget does not recognise, and Microsoft Store apps.
- Jarod-OS itself.

The coverage is never presented as complete.

## Installing

- **Nothing is installed automatically**, and there is no "update everything" button: one program at a time, chosen by the person.
- **Windows and drivers stay read-only:** "Ouvrir Windows Update" opens Windows' own Settings page (`ms-settings:windowsupdate`). Windows shows its own prompts and handles restarts.
- **Software:** "Mettre à jour…" on one row upgrades that winget package from Jarod (`electron/winget-install.ts`):

  1. **Prepare** (`updates.prepareUpgrade`). Main checks that:
     - the id, version and source are well formed (no option such as `--all`, no space, no shell character);
     - the package is in the last check, at the version it listed, from the source it listed;
     - Jarod's Internet is on.

     Main then returns a plan and a one-shot token (5 minutes, bound to that exact id, version and source).
  2. **Confirm.** The panel shows the name, the **winget id**, the **version** (current → target), the **source**, and the exact command. It also says that the licence and the source's terms are accepted on the person's behalf, and that Windows may ask for administrator rights. Nothing runs before "Installer <id> <version>".
  3. **Run** (`updates.upgrade(token)`):
     - the token is spent (none, a spent one or an expired one is refused before anything else);
     - the call goes through the control gate as `shell.winget.upgrade` (tier `mutate`, arguments exactly `id`, `version`, `source`; a plugin cannot reach it);
     - the Internet is checked again (a refusal at this point is journalled as `denied-policy`);
     - winget is started **with an argument array, without a shell**:

       ```
       winget upgrade --id <id> --exact --version <version> --source <source> --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
       ```

       The agreements flags exist only in this confirmed command (`wingetUpgradeArgs` throws without the confirmation).
     - The control journal (`control-audit.jsonl`) gets exactly one line: `shell.winget.upgrade`, source `updates`, reason `<id> <version> (<source>): <outcome> [code]`.
- **Progress** is shown while it runs: phase (starting, downloading, verifying, installing), percentage when winget prints one, last line. One upgrade at a time.
- **Result:**
  - **terminé**;
  - **redémarrage nécessaire** (`0x8A150109`, `0x8A15010B`, or a restart notice at the end of the output);
  - **annulé** (`0x8A15010C`, e.g. elevation refused);
  - **échec**, with the reason (package in use, disk full, hash mismatch, blocked by policy, …; an unknown code is shown with winget's last line).

  A program that upgraded leaves the list.
- **Jarod never restarts the computer.**

## Real verification (2026-10-18, this machine)

A read-only run of the two checks:

- Windows Update returned 5 available drivers (Intel network, management engine, Wireless Manageability…), each marked "redémarrage possible";
- winget returned 2 programs (OLE DB Driver 19, VS Build Tools 2022).

Nothing was installed.

## Tests

`electron/updates-check.test.ts`:

- the real French `winget` table;
- the Windows / drivers split;
- search only;
- `electron/winget-install.test.ts` (winget mocked):
  - the argument array;
  - refusal without a confirmation, and of a spent or expired one;
  - invalid ids, versions and sources;
  - refusal offline, including after the confirmation;
  - packages, versions and sources that were not listed;
  - exit codes and output read as success, restart needed, cancelled or failed;
  - progress;
  - the catalogue entry, and the journal lines through the gate.
- `e2e/updates-upgrade.spec.ts`: the whole flow in the app with a scripted winget (`JAROD_WINGET_MOCK`, honoured only when `JAROD_OS_ISOLATED=1`). It covers the confirmation, progress, the result, the arguments received, the journal line, and the disabled button and refusal offline.

## Jarod-OS itself, A/B (V-21, experimental, off by default)

With `JAROD_HOST_UPDATER=1` and the `jarod-updater` binary (`JAROD_UPDATER_BIN` or PATH), Système › Mises à jour shows a "Jarod-OS (mise à
jour A/B)" block: the running version, the fallback, the blocked versions; "Installer une mise à jour signée…" (a folder holding a bundle
signed with Jarod's key, verified before the question); during a trial, "Cette version fonctionne" or "Revenir à la précédente". The Windows
package ships the binary, the `jarod-launcher` launcher and the contracts in `resources/updater`. Started by the launcher, the app
confirms its own trial as soon as its kernel is ready, and a version that crashes during its trial is rolled back and blocked (checked on
the packaged app, `scripts/probes/ab-update-probe.mjs`). Not yet: the installer's shortcut does not go through the launcher, and nothing
is downloaded. Details: `host-rust/docs/updater.md`. Tests:
`electron/host-updater.test.ts` and `e2e/host-updater.spec.ts` drive the real binary (skipped when it was not built).
