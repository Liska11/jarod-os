#!/usr/bin/env bash
# Scan every commit, and any uncommitted changes, for credentials with gitleaks
# (https://github.com/gitleaks/gitleaks). Uses gitleaks from PATH, or its Docker image.
#
#   bash scripts/check-secrets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="v8.30.1"

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks_run() { (cd "$ROOT" && gitleaks "$@"); }
elif command -v docker >/dev/null 2>&1; then
  # Inside the container the checkout belongs to another user; let git read it anyway.
  gitleaks_run() {
    docker run --rm -v "$ROOT:/repo" -w /repo \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "ghcr.io/gitleaks/gitleaks:$VERSION" "$@"
  }
else
  echo "check-secrets: install gitleaks (brew install gitleaks) or Docker" >&2
  exit 1
fi

echo "==> every commit"
# --verbose : fichier, ligne et empreinte de chaque détection (valeur masquée par --redact), pour la relire avant .gitleaksignore.
gitleaks_run git --redact --verbose --no-banner .
echo "==> staged changes"
gitleaks_run git --pre-commit --staged --redact --no-banner .
echo "==> unstaged changes"
gitleaks_run git --pre-commit --redact --no-banner .
