#!/usr/bin/env bash
# Inside the VM (UTM with a VirtioFS share): copy the repo from the shared folder into the home
# directory (native modules must be installed on Linux, so the tree is not used in place), build,
# and restart the shell.
#
#   herald-os-sync              # /mnt/herald-os -> ~/Herald-OS, build, restart
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

SRC="${JAROD_OS_SHARE:-/mnt/herald-os}"
REPO="${JAROD_OS_REPO:-$HOME/Herald-OS}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mountpoint -q "$SRC" || [[ -d "$SRC/apps/desktop" ]] || { echo "shared folder not mounted at $SRC" >&2; exit 1; }

echo "==> syncing $SRC -> $REPO"
mkdir -p "$REPO"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude release --exclude .git \
  --exclude 'upstream/hermes-agent' --exclude 'linux/vm/build' --exclude '.DS_Store' \
  "$SRC/" "$REPO/"

bash "$HERE/build.sh"
bash "$HERE/restart-shell.sh" || true
