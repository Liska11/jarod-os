# The Jarod disk

Jarod-OS can live on a drive of its own. The person picks it in the first-run setup (the "Le disque de Jarod-OS" step) or later in Settings › Storage. Everything Jarod-OS owns then lives under one root folder, `D:\Jarod-OS` by default.

## Layout

```
D:\Jarod-OS\
  .jarod-os-root.json   marker: this folder is a Jarod root (kind, version, created)
  data\                 the core's profile (jarod.db, keys) and the shell's home; protected
  workspace\            the folder conversations work in
  environments\         toolchains and runtimes Jarod-OS installs for projects
  backups\              snapshots of data\ and workspace\
  sandboxes\            throwaway copies where the agent tries risky changes
  vms\                  virtual machine disks and their settings
```

## How it is applied

- The choice is stored in the shell's config folder, in `%APPDATA%\Jarod-OS\config\data-location.json`.
- At startup, before anything reads the data paths, `electron/data-root.ts` reads it and sets three environment variables: `JAROD_OS_ROOT`, `JAROD_OS_DATA` (= `data\`) and `JAROD_WORKSPACE` (= `workspace\`). The core and the shell already follow these.
- Variables that are already set win over the stored choice. A test or a portable install sets them that way.
- If the chosen root is missing (the disk is unplugged, or its letter changed), Jarod-OS starts on its default folders and Settings says so. It never creates a fresh, empty root in its place.
- The path guard treats the root as the person's own space, so files there can be edited, and projects can live there. The exception is `data\`, which stays protected, like every other data folder.
- The Electron profile stays in `%APPDATA%\Jarod-OS`. It holds window state and the sign-ins of the sites in the right pane. So do the shell's settings. Both are small and tied to the Windows account.

## Choosing and moving

`electron/data-disk.ts` lists the drives (Win32_LogicalDisk) and flags some of them:

- the Windows drive;
- removable drives;
- network drives;
- FAT and exFAT drives, which have no permissions, no links and a 4 GB file limit;
- drives with less than 64 GB free.

Then it applies the choice:

1. **Refuse the wrong roots.** A root is refused if it is relative or UNC, inside Windows or Program Files, or inside the folders in use (or containing them).
2. **Take an existing root as it is.** A folder that already carries the marker is adopted unchanged, for example after a reinstall.
3. **Refuse an occupied folder.** A non-empty folder without the marker is refused. Nothing is ever mixed into someone's files.
4. **Prepare a new root.** An empty or new folder gets the subfolders and the marker.
5. **Copy the data in, if asked.** The backend stops, because its database is open. Then `data` and `workspace` are copied. Nothing is overwritten, and every file is checked for presence and size.
6. **Record the choice last.** The location is written only after the copy. So a failed copy changes nothing at the next start, and the backend is started again.
7. **Restart.** Jarod-OS restarts on the new root.

The old folders are kept, and the person is told where they are. Jarod-OS never formats, partitions or deletes anything.

## What lives on the disk

All four are in Settings › Storage, and each needs the Jarod disk: without one, the section says so. Each reads its folder from `JAROD_OS_ROOT`.

### Backups — `backups\<id>\` (electron/backups.ts)

- **What a backup holds.** `data\` and `workspace\`, plus a `backup.json` manifest that is written last. A folder without its manifest is an interrupted backup and is ignored.
- **Incremental through hard links.** A file unchanged since the previous backup (same size and modification time) is a hard link, not a copy. So a backup costs only what changed, and any backup can be deleted on its own. Folders that tools rebuild are skipped: `node_modules`, `.venv`, caches.
- **When.** Daily: at startup, when the last backup is more than a day old, before the core starts. Or by hand.
- **Consistency.** The core is stopped while `data\` is copied, because its database is open. It starts again right away; the workspace is copied afterwards.
- **Keeping.** The newest 10 are kept by default; the number can be set.
- **Restore.** The current folders are first moved into a `before-restore` backup (nothing is deleted). Then the backup is copied back and Jarod-OS restarts.

### Sandboxes — `sandboxes\<name>\` (electron/sandboxes.ts)

- **What a sandbox is.** A copy of a project, with a `.jarod-sandbox.json` file written last. `.git` is kept. The rebuildable folders are left out unless asked for.
- **Compare.** Files are compared by content and reported as added, modified or removed, against the project.
- **Apply.** All changes or only some. Added and modified files are copied into the project. Files removed in the sandbox go to the Recycle Bin in the project, never straight to deletion. The project must be a folder Jarod-OS may edit: home or the Jarod disk.
- **Throw away.** A sandbox goes to the Recycle Bin.

### Environments — `environments\<name>\` (electron/environments.ts)

- **Python.** A virtual environment made with `uv venv --python <version> --seed`; uv fetches the Python if it is missing.
- **Node.js.** The official Windows build from nodejs.org: the newest release of the asked version. It is unpacked with Windows' own `tar`, called by its full path, because Git's GNU tar reads `C:` as a remote host.
- **Manifest.** `env.json` is written last. A failed build is removed.
- **Terminal.** A Terminal tab can open inside an environment: its tools come first in `PATH` (and `VIRTUAL_ENV` is set for Python), and the tab starts in its folder.

### Virtual machines — `vms\<name>\` (electron/vms.ts)

These are WSL machines.

- **List.** The machines of this Windows account, with the folder holding each one's disk (read from the registry). Docker Desktop's own machines are hidden.
- **Install.** A new machine goes onto the disk with `wsl --install <distro> --name <name> --location <root>\vms\<name> --no-launch`. Its first start, in a Terminal tab, asks for a user.
- **Move.** An existing machine moves there with `wsl --manage <name> --move <folder>`, after it is stopped.
- **Open.** A Terminal tab runs `wsl -d <name>`.
- **Remove.** `wsl --unregister` erases the machine's disk, so the person must type its exact name first.
- **Requirements.** VMs need NTFS or ReFS and room, hence the FAT and low-space warnings. Starting a machine is always the person's decision.

Without a Jarod disk, the default folders are used: `%LOCALAPPDATA%\Jarod-OS` for data, and `Documents\Jarod-OS` for the workspace.
