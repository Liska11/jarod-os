#!/usr/bin/env bash
# One-shot developer bootstrap for Jarod-OS (macOS and Linux). Safe to re-run after every pull.
#   1. Fetch the pinned upstream snapshot (types for the gateway wire).
#   2. Install Node workspaces.
#   3. Link the system-bridge plugin into the user's Hermes plugins directory.
#   4. Find the Hermes runtime, migrate pre-rename settings, enable the plugin and its toolset.
#   5. Report voice support.
set -euo pipefail

# Variables renamed with Jarod-OS (2026-10-19): an older HERALD_OS_* still counts when JAROD_OS_* is unset (the new name wins).
# HERALD_OS_DEV_UNSIGNED keeps its name (contract c8). Only names are handled here; no value is printed.
for _old in $(compgen -e); do
  case "$_old" in
    HERALD_OS_DEV_UNSIGNED) ;;
    HERALD_OS_*) _new="JAROD_OS_${_old#HERALD_OS_}"; [[ -n "${!_new+x}" ]] || export "$_new=${!_old}" ;;
  esac
done
unset _old _new

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
JAROD_OS_HERMES_ROOT="${JAROD_OS_HERMES_ROOT:-${HERMES_OS_HERMES_ROOT:-}}"
OS="$(uname -s)"
export PATH="$HOME/.local/bin:$PATH"

# macOS: the /usr/bin shims refuse to run until the Xcode license is accepted; the CommandLineTools
# binaries behind them work. Prefer them so `npm install` (node-gyp) and git keep working.
if [[ "$OS" == "Darwin" && -d /Library/Developer/CommandLineTools/usr/bin ]]; then
  export PATH="/Library/Developer/CommandLineTools/usr/bin:$PATH"
  export SDKROOT="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
fi

echo "==> Syncing upstream snapshot"
bash "$ROOT/scripts/sync-upstream.sh"

echo "==> Installing Node workspaces"
(cd "$ROOT" && npm install)

# Electron fetches its binary on first use rather than at install; do it once here.
echo "==> Fetching the Electron binary"
(cd "$ROOT/apps/desktop" && node -e "require('electron')") || echo "    WARNING: could not download Electron; npm run dev will try again"

# npm strips the executable bit from node-pty's prebuilt spawn-helper; the app also repairs this at
# runtime, but fixing it here keeps packaged builds working. (Linux has no prebuilds; see
# linux/dev/build.sh, which compiles node-pty.)
helper="$ROOT/node_modules/node-pty/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper"
[[ -f "$helper" ]] && chmod 755 "$helper"

echo "==> Linking herald-os-bridge plugin into $HERMES_HOME/plugins"
mkdir -p "$HERMES_HOME/plugins"
# The pre-rename link points at a folder that no longer exists; remove it only when it is ours.
legacy="$HERMES_HOME/plugins/hermes-os-bridge"
if [[ -L "$legacy" && "$(readlink "$legacy")" == "$ROOT/plugins/"* ]]; then
  rm -f "$legacy"
  echo "    removed the pre-rename hermes-os-bridge link"
fi
link="$HERMES_HOME/plugins/herald-os-bridge"
if [[ -L "$link" || -e "$link" ]]; then
  rm -rf "$link"
fi
ln -s "$ROOT/plugins/herald-os-bridge" "$link"

echo "==> Verifying Hermes runtime"
HERMES_CMD=()
HERMES_PY=""
if [[ -n "$JAROD_OS_HERMES_ROOT" && -x "$JAROD_OS_HERMES_ROOT/venv/bin/python" ]]; then
  echo "    JAROD_OS_HERMES_ROOT=$JAROD_OS_HERMES_ROOT"
  HERMES_PY="$JAROD_OS_HERMES_ROOT/venv/bin/python"
elif [[ -x "$HERMES_HOME/hermes-agent/venv/bin/python" ]]; then
  echo "    managed install: $HERMES_HOME/hermes-agent"
  HERMES_PY="$HERMES_HOME/hermes-agent/venv/bin/python"
elif command -v hermes >/dev/null 2>&1; then
  echo "    hermes on PATH: $(command -v hermes)"
  HERMES_CMD=(hermes)
  # A pip/uv install's entry point names its interpreter on the first line.
  shebang="$(head -1 "$(command -v hermes)" 2>/dev/null | sed -n 's/^#!\(.*python[0-9.]*\)$/\1/p')"
  [[ -n "$shebang" && -x "$shebang" ]] && HERMES_PY="$shebang"
else
  echo "    WARNING: no Hermes runtime found. Install it, then re-run this script:" >&2
  echo "      curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" >&2
fi
[[ -n "$HERMES_PY" && ${#HERMES_CMD[@]} -eq 0 ]] && HERMES_CMD=("$HERMES_PY" -m hermes_cli.main)
runtime_root="${JAROD_OS_HERMES_ROOT:-$HERMES_HOME/hermes-agent}"

# From the runtime checkout, like the `hermes` entry point: an editable install does not map
# top-level modules added after it was created.
hermes_run() {
  (cd "$runtime_root" 2>/dev/null || true; "${HERMES_CMD[@]}" "$@" </dev/null)
}

if [[ ${#HERMES_CMD[@]} -gt 0 ]]; then
  if [[ -n "$HERMES_PY" ]]; then
    echo "==> Migrating settings from the pre-rename Hermes OS"
    HERMES_HOME="$HERMES_HOME" PYTHONPATH="$runtime_root${PYTHONPATH:+:$PYTHONPATH}" "$HERMES_PY" "$ROOT/scripts/migrate-hermes-config.py" || true
  fi

  echo "==> Enabling the system bridge plugin and its toolset"
  # User plugins are opt-in (plugins.enabled) and a saved platform toolset list is authoritative, so
  # both must be recorded. The override prompt is answered "no" (stdin closed): the bridge never
  # replaces built-in tools.
  hermes_run plugins enable herald-os-bridge >/dev/null 2>&1 || true
  hermes_run tools enable herald_os 2>&1 | tail -1 || true
  # Upstream defers plugin tools behind its tool-search bridge; with the system tools hidden the
  # agent falls back to shell commands. Keep them direct (Settings -> Permissions can flip it back).
  echo "    tools.tool_search.enabled = off (system tools stay directly callable)"
  hermes_run config set tools.tool_search.enabled off >/dev/null 2>&1 || true

  echo "==> Checking voice support (docs/VOICE.md)"
  # The Live engine and the spoken-reply turn note need the voice-live routes (Hermes 0.21.3 and
  # later). Git installs report version 0.0.0, so look for the module rather than the version.
  if [[ -f "$runtime_root/tools/voice_live.py" ]]; then
    echo "    voice-live routes: available"
  elif [[ -d "$runtime_root" ]]; then
    echo "    WARNING: this Hermes has no voice-live routes; run 'hermes update' for the Live voice engine." >&2
  fi
  if [[ -n "$HERMES_PY" ]]; then
    "$HERMES_PY" - <<'PY' || true
import importlib
for name, purpose in (("openwakeword", "wake word"), ("faster_whisper", "local STT"), ("edge_tts", "free TTS")):
    try:
        importlib.import_module(name)
        print(f"    {name}: ok ({purpose})")
    except Exception:
        print(f"    {name}: missing ({purpose}); install with: pip install 'hermes-agent[voice]' inside the Hermes venv")
PY
  fi
fi

echo "==> Done. Start Jarod-OS with: npm run dev"
