# Hotkeys

On Jarod-OS Linux the system key is `Super` (the Windows or Command key); in the virtual machine on
a Mac it is `Alt` instead, because macOS keeps `Command` for itself. `Super+K` shows every Linux
shortcut on screen. Jarod's own pages also answer to `Ctrl` on Linux, so `Ctrl+K` and `Ctrl+1`
work everywhere.

## Hermes and Jarod-OS

| Action | macOS | Jarod-OS Linux |
| --- | --- | --- |
| Command bar | `Cmd+K` | `Super+Shift+Space` or `Ctrl+K` |
| All applications | `Cmd+Shift+A` | `Super+A` |
| Talk to Hermes | `Alt+Space` | `Super+V` |
| Dictate into any app (again, or a pause, to finish) | `Cmd+Ctrl+X` | `Super+Ctrl+X` |
| Emoji, typed into any app | `Cmd+Ctrl+E` | `Super+Ctrl+E` |
| Ask about part of the screen | `Cmd+Shift+S` | `Super+Shift+S` |
| Ask about the focused window | | `Super+Space` |
| Screenshot of the whole screen, to Hermes | | `Super+Ctrl+Shift+S` |
| Jarod-OS menu: apps, themes, updates | | `Super+M` or `Super+Alt+Space` |
| Show these hotkeys | | `Super+K` |
| Overview, Hermes, Missions, Memory, Files, Automations, Connections | `Cmd+1` ... `Cmd+7` | `Ctrl+1` ... `Ctrl+7` |
| Settings | `Cmd+,` | `Super+,` |
| Terminal | `Cmd+8` | `Super+Return` |
| Files | | `Super+E` |
| Browser | | `Super+Shift+Return` |
| System monitor | | `Super+I` |
| Missions | | `Super+Shift+M` |
| The Hermes window | | ``Super+` `` |
| Toggle the sidebar | `Cmd+\` | `Ctrl+\` |
| Clipboard history | | `Super+Ctrl+V` |
| Lock, power menu | | `Super+Ctrl+L`, `Super+Escape` |
| Leave or enter fullscreen, quit | `Cmd+Ctrl+F`, `Cmd+Q` | `Super+Shift+Escape` quits the session |

## Windows (Jarod-OS Linux)

| Action | Keys |
| --- | --- |
| Close the window | `Super+Q` |
| Focus left, right, down, up | `Super+H`, `Super+L`, `Super+J`, `Super+U` or the arrow keys |
| Move the window | `Super+Shift` with the same keys |
| Make the column wide, fullscreen | `Super+F`, `Super+Shift+F` |
| Float or tile the window | `Super+T` |
| Tabs in a column, centre the column | `Super+W`, `Super+C` |
| Overview of every window | `Super+O` |
| Column width presets, narrower, wider | `Super+R`, `Super+Minus`, `Super+Equal` |
| Spaces: Personal, Work, Ideas | `Super+1`, `Super+2`, `Super+3` (with `Shift` to move the window there) |
| Previous window | `Super+Tab` |

## Quick panels and switches (Jarod-OS Linux)

| Action | Keys |
| --- | --- |
| Wi-Fi, Bluetooth, sound | `Super+Ctrl+W`, `Super+Ctrl+B`, `Super+Ctrl+A` |
| Displays, battery and power | `Super+Ctrl+D`, `Super+Ctrl+P` |
| Night light, stay awake, do not disturb | `Super+Ctrl+N`, `Super+Ctrl+I`, `Super+Ctrl+,` |
| Turn the screens off | `Super+Shift+P` |

## Capture (Jarod-OS Linux)

| Action | Keys |
| --- | --- |
| Screenshot of a selection | `Print` |
| Screenshot of the window, of the screen | `Super+Print`, `Super+Shift+Print` |
| Record the screen (again to stop) | `Super+Alt+Print` |
| Pick a colour from the screen | `Super+Ctrl+Print` |
| Ask Hermes about part of the screen | `Super+Shift+S` |

## Omarchy keys (Jarod-OS Linux)

Coming from Omarchy? Settings > General > Keymap, or `herald-os keymap omarchy`, makes `Super+C`,
`Super+X` and `Super+V` copy, cut and paste in every app, terminals included. Talking to Hermes
moves to `Super+Shift+V` and centring a column to `Super+Ctrl+C`; `herald-os keymap herald` switches
back.

## Your own shortcuts

On Jarod-OS Linux, add binds to `~/.config/niri/local.kdl`, which Jarod-OS never overwrites; any
`herald-os` command can be a bind, and binding a key Jarod-OS already uses replaces it.
[Make it yours](make-it-yours.md#keyboard-shortcuts) has examples, including switching a key off,
and Hermes can write them for you: "add a shortcut that opens Obsidian".
