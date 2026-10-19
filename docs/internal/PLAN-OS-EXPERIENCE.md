# Plan: from "Linux with a nice shell" to an OS

Status: Phases 1-3 implemented and verified in the VM (see `docs/LINUX.md` for how to use the
result). Remaining from the original list: nothing; follow-ups are noted at the end.

Six changes, in three phases, each verified in the Linux VM and committed before the next. The
thread through all of them: Hermes owns every window, every hotkey and every system chore, so a
user never leaves Jarod-OS to do something.

Compositor: **niri** (Fedora official repos; Hyprland has no Fedora aarch64 packages). Scrollable
tiling, JSON IPC + event stream, window rules, `layout.struts`, named workspaces, fractional output
scale, built-in screenshots and hotkey overlay.

niri needs hardware GL on its DRM backend (Smithay skips software EGL). QEMU from Homebrew and
Apple's Virtualization framework (vfkit) both expose a 2D-only virtio-gpu (`-virgl`), so in those
VMs `herald-os-compositor` nests niri's windowed backend inside cage (cage owns the display with
software rendering; niri still manages every window). On hardware, or in UTM's QEMU with virgl,
niri runs on the tty directly. `JAROD_OS_NIRI_NESTED=0|1` overrides the detection.

## Architecture change: the shell becomes panels

Today the Electron shell is one fullscreen window that draws wallpaper, menu bar, dock and windows
itself (`desktop` mode: macOS, cage). Under niri the shell runs in **`panels` mode**: several
Electron windows, each a surface, positioned by niri window rules; niri manages every window
including foreign apps.

| Surface | niri placement | Content |
| --- | --- | --- |
| `menubar` | floating, top, full width, no focus on open, strut 30 | brand, focused window title, workspaces (= Spaces), status |
| `dock` | floating, bottom centre, auto-hide handled by the shell | pinned apps + every running niri window with icon, click = focus |
| `main` | tiled (the Hermes window) | sidebar + pages, approvals, toasts |
| `command` | floating, centred, on demand | ⌘K / launcher / "ask Hermes" with the focused window as context |
| `window:terminal`, `window:system`, `window:chat-popout` | tiled or floating | existing surfaces, one Electron window each |
| wallpaper | `swaybg` (layer-shell, backdrop) | PNG rendered from the procedural wallpaper by an offscreen window |

Main process gains `electron/shell/` (mode, panel windows, relay between windows, control socket)
and `electron/wm/niri.ts` (event-stream client + actions). Renderer gains a `surface` entry
selector; stores that act across windows go through a small relay (`shell.relay('main', …)`).

## Phase 1: own every window, one keyboard grammar (ideas 1, 2)

- `linux/niri/config.kdl`: outputs (fractional scale), layout (gaps, struts, Hermes border/focus
  colours, rounding), `prefer-no-csd`, named workspaces (personal/work/ideas), window rules for
  shell surfaces and common apps, binds (below), `spawn-at-startup` (session, swaybg, portals),
  screenshot path, hotkey overlay.
- Keyboard grammar (Super = Mod): `Mod+Space` ask Hermes (command bar, focused-window context),
  `Mod+A` applications, `Mod+Return` terminal, `Mod+E` files, `Mod+Q` close, `Mod+F` fullscreen,
  `Mod+T` toggle floating, `Mod+H/L` focus columns, `Mod+Shift+H/L` move, `Mod+1..3` Spaces,
  `Mod+O` overview, `Mod+K` hotkey overlay, `Mod+Escape` power menu, `Mod+Ctrl+L` lock,
  `Print` screenshot, `Mod+C/V` clipboard (Phase 2 history).
- `herald-os-compositor` runs niri (`JAROD_OS_COMPOSITOR=cage` keeps Stage 1). Session exports
  `JAROD_OS_SHELL_MODE=panels`.
- Electron: panels mode, niri IPC client, `wm.*` IPC (state, focus, close, workspace, floating,
  fullscreen, screenshot), control socket `$XDG_RUNTIME_DIR/herald-os.sock` + `herald-os` CLI
  (`ask`, `launcher`, `applications`, `page`, `open`, `screenshot`, `lock`, `wm …`).
- Renderer: surface selector; MenuBar with niri workspaces + focused title; Dock with running
  windows + icons from `.desktop` app-id match; command surface with window context.
- Verify: boot to niri; Firefox tiles beside Hermes with Hermes borders; Dock shows it; `Mod+Space`
  over Firefox asks Hermes about the page title; `Mod+Q`, `Mod+1..3`, `Mod+K`, `Print` work.

## Phase 2: one control surface, system services (ideas 3, 4)

- `herald-os` CLI grows: `install app|webapp`, `remove`, `update`, `theme list|set`, `font`,
  `reminder`, `notice time|battery|weather`, `clipboard`, `ocr`, `lock`, `suspend`, `debug`.
- Control menu (`Mod+Alt+Space`): Install / Remove / Update / Style / Setup / Trigger / System,
  same commands as the CLI. Every command also a bridge tool (`system_os`) with tiers.
- Services: clipboard history (`cliphist` + picker surface), reminders (`systemd-run --user
  --on-active` → notification), notices, screenshots (niri) and OCR (`slurp` + `tesseract`),
  notification daemon (org.freedesktop.Notifications in Electron main so foreign apps' notifications
  land in Hermes), lock screen (`swaylock` themed) + idle (`swayidle`), power menu, web apps as
  frameless Electron windows (`herald-os install webapp <name> <url>`), boot splash (Plymouth).

## Phase 3: whole-system themes, omakase, updates (ideas 5, 6)

- Theme engine: `linux/themes/<name>/theme.json` → shell tokens, niri colours, GTK (`gsettings`,
  `gtk.css`), swaylock, terminal palette, swaybg wallpaper set; `herald-os theme set` applies
  atomically; Hermes tool to switch.
- Omakase: `linux/omakase/{packages,flatpaks,webapps}.txt` installed by provisioning; Hermes knows
  the set (SKILL.md). Curated: Firefox, Nautilus, Text Editor, LibreOffice, Obsidian (Flatpak),
  Spotify (Flatpak), VS Code, LocalSend, web apps (HEY, Google Calendar, WhatsApp, X).
- Updates: `herald-os update` (git pull to a release channel, `linux/migrations/*.sh` tracked in
  `/var/lib/herald-os/migrations`, `dnf upgrade`, `flatpak update`, `hermes update`, shell rebuild
  + restart); menu-bar indicator via a daily timer; channels `stable|edge`.

## Out of scope (still Stage 2 security work)

Capability broker, sandboxing, our own compositor, SELinux policy.

## Follow-ups noted while building

- Release channels are placeholders (both track `main`); cut tagged releases and point `stable` at them.
- Dictation (Omarchy's Voxtype) has no Fedora package; Hermes's own voice path is the candidate.
- The in-shell Terminal palette does not yet follow the theme (foot does).
- Web-app windows are titled by name but share the shell's app id; the Dock shows them by title.
- GPU-less VMs run niri nested in cage (software rendering); UTM with virgl or real hardware runs niri directly.
