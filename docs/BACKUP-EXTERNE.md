# External backup

Réglages › Stockage › **Sauvegarde externe** saves an independent copy of Jarod-OS to another disk, for example a USB drive. It is separate from two other things:

- the Jarod disk's own backups, which live on the same disk as the data (`docs/JAROD-DISK.md`);
- moving the Jarod disk.

Code:

- `electron/external-backup.ts` (logic);
- `electron/external-destination.ts` (destination);
- `electron/ipc/external-backup.ts` (service);
- `src/features/settings/sections/ExternalBackupBlock.tsx` (UI);
- in the core: `gateway/maintenance.ts` and `storage/db.ts:snapshotWithoutSecrets`.

## Layout

```
<chosen folder>\Jarod-OS-Backups\<install id>\<date-time-id>\
  jarod-backup.json        manifest, written last (status "complete")
  data\…  workspace\…  config\prefs.json  [environments\…  sandboxes\…  vms\…]
```

- **The install id** is generated once, in `config\instance.json`. On a fresh install, the backups of every install found on the disk are listed and can be restored.
- **A backup is first built as `<id>.incomplete`.** It is renamed only once every file has been copied, hashed and read back from the disk. An incomplete folder is never listed and never restorable.
- **Its marker is `jarod-backup.json`.** It is distinct from an active install's marker, `.jarod-os-root.json`, so a backup is never taken for an install.
- **No mirroring, no pruning.** Every backup is a new folder, and Jarod never deletes an old backup.

## Destination

| Rule | Detail |
|---|---|
| Accepted | Any local drive with a letter, removable drives included. |
| Refused | A relative path, a network path (UNC), the Windows and Program Files folders, a folder inside what is backed up or containing it. The comparison is made after resolving links and junctions. |
| Warnings | FAT32 (4 GB per file), exFAT (no permissions), network drive, **same physical disk** as the data (`Get-Partition`/`DiskNumber`). |
| Identity | The volume's `UniqueId` is recorded when the folder is chosen. Another disk under the same letter shows "un autre disque", and nothing is written to it. A missing disk is never silently replaced by another destination. |
| Space | Checked before starting: estimate + 5% + 256 MB. |
| Formatting | Never. Files already on the disk are never modified. |

## Content

| Part | Default | Content |
|---|---|---|
| `data` | yes | The core's profile (conversations, memory, attachments, the DPAPI-protected key) |
| `workspace` | yes | The working folder |
| `config` | yes | `prefs.json` only |
| `environments`, `sandboxes` | no | On the Jarod disk |
| `vms` | no | On the Jarod disk. Refused while one of its machines is running. Restored apart (see below) |

### Always excluded (listed before starting, and in the manifest)

- **The vault values and the providers' keys.** The core's database is copied through the core's maintenance mode: `VACUUM INTO` a copy with the same key, then the values of the `secrets` table are deleted and the file is vacuumed, so freed pages keep nothing. Vault names and domains remain, without values: you enter the values again after a restore. The internal safety copies of the database (`*.avant-*`, `backups/*.bak`) hold the vault and are left out.
- Web sessions:
  - the Electron profile `%APPDATA%\Jarod-OS`;
  - `herald-userdata`.
- Plain-text key files: `.env`, `auth.json`.
- Logs.
- Rebuildable folders: `node_modules`, `.venv`, caches.
- Links and junctions: never followed.
- Local models and engines: they can be downloaded again.
- The backups themselves.
- Shell settings that belong to this machine:
  - where the Jarod disk is;
  - the Internet switch, which a restore must never turn back on;
  - local state.

**The backup is therefore not a complete copy of the profile.** The UI says so.

## Consistency

- **Engine.** The core is stopped *before* the files are listed, because its temporary files disappear when it stops. It starts again as soon as the data part is copied, and **only if it was running**.
- **Database.** `VACUUM INTO` folds the journal (WAL) into the copy.
- **One operation at a time.** Local backup, external backup and restore share a lock (`operation-lock.ts`).
- **Verification.** Every file is hashed (SHA-256) while it is copied, then read back from the destination and compared.
- **Manifest.** It records:
  - format and app version;
  - date and parts;
  - exclusions;
  - number of secret values removed;
  - every relative path with its size and hash.

## Errors

| Error | What happens |
|---|---|
| Disk full, file locked, disk unplugged, permissions, cancellation, or the app quitting | The operation's `<id>.incomplete` folder is removed. Its `jarod-backup-operation.json` file proves it belongs to the operation. Nothing else is ever removed. |
| An interrupted backup (crash) | Its leftovers are cleaned at the next backup, under the same proof. |
| A file that disappears between the listing and its copy | Noted in the exclusions, not counted as an error. |

## Restore

1. A confirmation that explains the steps, the secrets that must be entered again, and the VMs.
2. A full check on the disk: manifest; relative paths only (no absolute path, no drive, no `..`, no unknown part); each file a regular file of the right size and hash.
3. A copy into staging folders next to the targets (`<target>.restoring-<tag>`), hashed again.
4. The engine stops. The current folders are **renamed aside** (`<target>.before-restore-<tag>`): they are kept, never deleted by Jarod. The staged folders take their place. If one rename fails, everything is put back.
5. `prefs.json` is replaced, and the old one is kept as `prefs.json.before-restore-<tag>`. VMs go to `vms.restored-<tag>` and never replace machines in use: re-register them with `wsl --import-in-place` if needed.
6. Jarod-OS restarts.

**Limit: the restored database opens only under the same Windows account.** Its key is protected by DPAPI, so a restore on another account or another PC does not open it. A portable backup, protected by a password, is a later step: the core already has `backupTo(path, password)`.

## Automatic backup

- **Off by default.** Frequency: 6 h, 12 h, 24 h, 3 days or 7 days.
- **When it is checked.** Every hour, the first time two minutes after startup.
- **When it runs.** Only if it is due, the disk is there and is the same volume, no other operation is running, and the core is running. Otherwise it is **put off**, and Settings says why.
- **Never at quit.** A backup in progress at quit is cancelled, and its folder is removed.
- **No old backup is ever deleted.**

## Encrypted archive (restic)

Settings › Storage › External backup › **Encrypted archive (restic)**. It is off by default and was added on 2026-10-21.

- **What it does.** After each successful backup, the backup folder is also archived in an encrypted, deduplicated restic repository on the same disk: `<destination>\Jarod-OS-Restic\<instance>`. The Jarod manifest travels inside the snapshot. **Nothing is ever deleted** from the repository: no `forget`, no `prune`.
- **If archiving fails.** The backup still succeeds; Settings says that the archive failed.
- **The key.** It is generated in the main process and **stored encrypted by Windows**: Electron's `safeStorage`, which is DPAPI for this account and this app profile. It sits in `restic-key.bin`, in the configuration folder, which backups never copy. It never reaches the window: the screen only shows an 8-character fingerprint.
- **The recovery sheet.** It holds the key, the repository path and the restic commands to read the repository **without Jarod**. The native "Save as" box of the main process writes it when the archive is turned on, and again on demand. It is refused next to the repository. Until it is saved, Settings says so: losing the PC or its profile loses the key.
- **An existing repository** is never re-initialised. Without its key, turning the archive on is refused (`repo-without-key`); the wrong key is refused too.
- **Restore a snapshot.** The snapshot is extracted to a temporary folder, then follows exactly the path of an ordinary restore: checked again against its manifest, staged, and swapped in beside the previous state. Jarod-OS then restarts.
- **Check the repository.** `restic check`, reading 5 % of the data.
- **Where restic comes from.** `JAROD_RESTIC`, else `JAROD_ENGINES_DIR\restic`, else the repository's `engines` folder, else `resources\restic` in the package. The Windows package carries restic 0.19.1 with its BSD-2 licence text. `npm run bundle:restic` checks it at every packaging (the official zip, the extracted executable and the licence, against `jarod-core/engines.lock/restic.json`) and stops the packaging on any difference.

## Tests

| Test | What it covers |
|---|---|
| `electron/external-backup.test.ts` (15 tests) | Plan and exclusions; junctions not followed; complete backup with hashes; cancellation; failure that removes only the operation's own folder; leftovers; refused manifests; damaged or missing files detected; restore with the previous state kept; failed swap undone; destinations (removable, system, UNC, inside the sources, space, same disk) |
| `jarod-core/packages/plugins/storage/test/snapshot-without-vault.test.ts` | The copy stays encrypted with the same key; conversations and the journal are in it; values removed, even from freed pages; source unchanged |
| `e2e/external-backup.spec.ts` (real app, throwaway folders) | A fake secret entered in Settings; backup complete, with no byte of the value; the core starts again; the backup is listed in Settings; restore of the workspace with the previous one kept; after the restart, the restored database opens (secret name present, no value) |

**Not tested for real:**

- a real USB drive unplugged during a copy;
- a full disk;
- a restore on a different Windows account (expected to fail, see the limit above).
