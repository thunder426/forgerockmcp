#!/usr/bin/env bash
# Install every CLI and runtime the local stack needs.
# Idempotent — Homebrew skips anything already installed.

set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install it from https://brew.sh first." >&2
  exit 1
fi

# Formulae (CLIs). bash 5 is required by some forgeops scripts; macOS ships bash 3.
FORMULAE=(
  minikube
  kubernetes-cli
  kustomize
  helm
  jq
  bash
  python@3.13
)

# Casks (apps). OrbStack provides the docker daemon Minikube's docker driver needs.
CASKS=(
  orbstack
)

echo "▶ Installing CLIs: ${FORMULAE[*]}"
brew install "${FORMULAE[@]}"

echo "▶ Installing apps: ${CASKS[*]}"
brew install --cask "${CASKS[@]}"

echo "✓ All dependencies installed."
echo
echo "Next steps:"
echo "  1. Open OrbStack once to grant it permissions (it'll start the docker daemon)."
echo "  2. Add this line to /etc/hosts (needs sudo):"
echo "       127.0.0.1 forgeops.example.com"
echo "  3. cp ops/env/.env.example ops/env/.env"
echo "     cp mcp-server/env/.env.example mcp-server/env/.env"
echo "     cp agent/env/.env.example agent/env/.env"
echo "  4. (cd ops && make preflight)"
