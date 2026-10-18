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

## What comes next on the disk

- **Backups** go in `backups\<date>\`:
  - a consistent copy of `data\`, taken with the core paused or through SQLite's backup API;
  - an incremental copy of `workspace\`;
  - retention by count and age, set in Settings.
  - A restore is a move in reverse: copy, check, then switch.
- **Sandboxes** go in `sandboxes\<name>\`: a copy of a project, or a git worktree, where the agent works without touching the original. Results come back as a diff the person accepts. A sandbox is deleted only on request, and goes to the Recycle Bin.
- **Environments** go in `environments\<name>\`: per-project runtimes (Node, Python with `uv`, toolchains), so the system stays clean, together with a manifest that describes how to rebuild each one.
- **VMs** go in `vms\<name>\`: Hyper-V or WSL disks (`.vhdx`), created and imported there, for example with `wsl --import <name> D:\Jarod-OS\vms\<name> <tar>`.
  - They need NTFS or ReFS and room, hence the FAT and low-space warnings.
  - Starting a VM is always the person's decision.

Each feature reads its folder from `JAROD_OS_ROOT`. Without a Jarod disk, the default folders are used: `%LOCALAPPDATA%\Jarod-OS` for data, and `Documents\Jarod-OS` for the workspace.
