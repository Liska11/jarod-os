#!/usr/bin/env bash
# Jarod-OS Linux, the per-machine half: the session user and everything in a home folder. Runs as
# root and is safe to re-run. The shell's first-boot setup then lets the person choose a name and a
# password, join Wi-Fi and sign in to Hermes.
#
#   firstboot.sh system   the user, the home folder, Hermes Agent: before the login screen
#                         (herald-os-firstboot.service)
#   firstboot.sh apps     the omakase Flatpaks, after the login screen is up
#                         (herald-os-firstboot-apps.service)
#   firstboot.sh          both, in order (the development VM's provisioner)
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

PHASE="${1:-all}"
HERMES_USER="${HERMES_USER:-hermes}"
STATE=/var/lib/herald-os
mkdir -p "$STATE"

step() { echo; echo "--- $*"; }
as_user() { sudo -u "$HERMES_USER" -H "$@"; }

# Where packages.sh put the shared files: the image's /usr/share/herald-os or the VM's /usr/local share.
SHARE=""
for candidate in /usr/share/herald-os /usr/local/share/herald-os-linux "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; do
  if [[ -f "$candidate/niri/config.kdl" && -d "$candidate/session" ]]; then
    SHARE="$candidate"
    break
  fi
done
[[ -n "$SHARE" ]] || { echo "firstboot: the Jarod-OS files are missing (run packages.sh first)" >&2; exit 1; }

system_phase() {
  step "The session user ($HERMES_USER)"
  if ! id "$HERMES_USER" >/dev/null 2>&1; then
    # No password yet: the lock screen refuses until one is set (first-boot setup or herald-os password).
    useradd -m -G wheel "$HERMES_USER"
    passwd -d "$HERMES_USER" >/dev/null
  fi
  HOME_DIR="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
  usermod -aG video,input,render,audio "$HERMES_USER" 2>/dev/null || true
  if getent group seat >/dev/null; then
    usermod -aG seat "$HERMES_USER" || true
  fi
  # The user's systemd instance (pipewire, portals) keeps running when no one is logged in.
  loginctl enable-linger "$HERMES_USER" || true
  sed -i "s/^user = .*/user = \"$HERMES_USER\"/" /etc/greetd/config.toml

  step "The login screen"
  # Anaconda picks multi-user.target unless its kickstart says otherwise, because greetd provides
  # no service(graphical-login); only graphical.target starts greetd and so the session.
  if [[ "$(systemctl get-default)" != "graphical.target" ]]; then
    systemctl set-default graphical.target
    systemctl --no-block start graphical.target
  fi

  step "Home folder"
  as_user mkdir -p "$HOME_DIR/.local/bin" "$HOME_DIR/.local/share" "$HOME_DIR/.local/state" "$HOME_DIR/.config/herald-os" "$HOME_DIR/.config/niri" "$HOME_DIR/.config/swaylock" "$HOME_DIR/.config/systemd/user"
  as_user env XDG_RUNTIME_DIR="/run/user/$(id -u "$HERMES_USER")" systemctl --user enable herald-os-update-check.timer 2>/dev/null || true
  as_user herald-os-theme set "$(as_user herald-os-theme current)" || true
  # niri's config, rendered with the person's keymap (managed; local.kdl is theirs).
  as_user herald-os keymap apply || install -m 0644 -o "$HERMES_USER" -g "$HERMES_USER" "$SHARE/niri/config.kdl" "$HOME_DIR/.config/niri/config.kdl"
  install -m 0644 -o "$HERMES_USER" -g "$HERMES_USER" "$SHARE/session/swaylock.conf" "$HOME_DIR/.config/swaylock/config"

  step "Hermes Agent for $HERMES_USER"
  if [[ -f /etc/herald-os/ref ]]; then
    # shellcheck disable=SC1091
    source /etc/herald-os/ref
  fi
  local ref="${HERMES_REF:-main}" agent="$HOME_DIR/.hermes/hermes-agent"
  if [[ ! -x "$agent/venv/bin/python" ]]; then
    as_user bash -euo pipefail -c "
      mkdir -p '$HOME_DIR/.hermes'
      if [[ ! -d '$agent/.git' ]]; then
        # Every commit, but file contents only as checkouts need them: a quarter of the full download.
        git clone --filter=blob:none https://github.com/NousResearch/hermes-agent '$agent'
      fi
      cd '$agent'
      git fetch --quiet origin '$ref' || true
      git checkout --quiet '$ref' || git checkout --quiet main
      # setup-hermes.sh asks two yes/no questions (ripgrep, setup wizard); answer no to both.
      printf 'n\nn\n' | bash ./setup-hermes.sh
    " || echo "WARNING: Hermes Agent did not install (offline?); herald-os setup retries it"
  else
    echo "already installed: $agent"
  fi
  if [[ -x "$agent/venv/bin/python" ]]; then
    # Voice: local transcription, free neural voices and the "hey hermes" wake word.
    as_user bash -c "cd '$agent' && PATH=\"\$HOME/.local/bin:\$PATH\" uv pip install --python venv/bin/python -q -e '.[voice,edge-tts,wake-openwakeword]'" || echo "voice extras failed; voice falls back to cloud providers"
    # The bridge plugin that lets Hermes use the system. The image ships it with the shell; the
    # development VM links the repo's copy when it builds the shell.
    if [[ -d /usr/share/herald-os/bridge ]]; then
      as_user herald-os setup --yes || echo "WARNING: herald-os setup did not finish"
    fi
  fi
  date -Is >"$STATE/firstboot-done"
}

apps_phase() {
  step "Omakase apps (JAROD_OS_OMAKASE=0 to skip)"
  if [[ "${JAROD_OS_OMAKASE:-1}" == "1" ]]; then
    as_user herald-os-omakase install --flatpaks || echo "WARNING: omakase flatpaks incomplete"
    # Web apps need the shell's icon fetch; herald-os-session installs them on the first login.
  fi
  date -Is >"$STATE/firstboot-apps-done"
}

case "$PHASE" in
  system) system_phase ;;
  apps) apps_phase ;;
  all) system_phase; apps_phase ;;
  *) echo "usage: $0 [system|apps]" >&2; exit 2 ;;
esac
echo "==> first boot ($PHASE) done"
