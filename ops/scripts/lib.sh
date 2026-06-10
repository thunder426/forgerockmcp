#!/usr/bin/env bash
# Shared helpers for the bring-up scripts. Source, don't execute.

set -euo pipefail

OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${OPS_ROOT}/.." && pwd)"
ENV_FILE="${OPS_ROOT}/env/.env"
SERVER_ENV_FILE="${REPO_ROOT}/mcp-server/env/.env"
AGENT_ENV_FILE="${REPO_ROOT}/agent/env/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy ops/env/.env.example to ops/env/.env and edit." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

FORGEOPS_PATH="${OPS_ROOT}/${FORGEOPS_DIR}"

require() {
  local missing=()
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Missing required commands: ${missing[*]}" >&2
    echo "Install with: brew install ${missing[*]}" >&2
    exit 1
  fi
}

log() { printf '\033[0;36m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[0;33m! %s\033[0m\n' "$*" >&2; }
err() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; }
