# Checking for updates

**Système › Mises à jour** has a "Vérifier les mises à jour" button.

| Code | Role |
|---|---|
| `electron/updates-check.ts` | The checks |
| `electron/ipc/updates-check.ts` | The screen's calls |
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

- **Nothing is installed automatically**, and there is no "update everything" button.
- **Windows and drivers:** "Ouvrir Windows Update" opens Windows' own Settings page (`ms-settings:windowsupdate`). Windows shows its own prompts and handles restarts.
- **Software:** "Mettre à jour…" on one row opens a Terminal tab running this command:

  ```
  winget upgrade --id <id> --exact
  ```

  - It is interactive: agreements and elevation are winget's own prompts, answered by the person.
  - The id is checked: an id like `--all` is refused.
- **Jarod never restarts the computer.**

## Offline

- **While Jarod's Internet is off, no check runs:** the button is disabled, and main refuses the call too.
- **The last results are shown with their date, marked "anciens".**
- **Upgrading a program is refused** (`assertInternet`).

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
- the upgrade command refused for a bad id and while offline.
