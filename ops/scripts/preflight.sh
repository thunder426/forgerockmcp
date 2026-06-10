#!/usr/bin/env bash
# Verify required tooling is installed and at usable versions.
# Versions are the ForgeOps 2025.1 recommendations; the script warns rather than blocks.

source "$(dirname "$0")/lib.sh"

log "Checking required CLIs"
require docker kubectl kustomize helm jq minikube python3 bash

# OrbStack exposes a docker socket; verify it's reachable.
if ! docker info >/dev/null 2>&1; then
  err "docker CLI cannot reach a daemon. Start OrbStack (or Docker Desktop) and retry."
  exit 1
fi
ok "docker daemon reachable"

# Minikube must use a driver that can reach the host docker daemon.
minikube_version=$(minikube version --short 2>/dev/null | sed 's/^v//')
ok "minikube $minikube_version"

kubectl_version=$(kubectl version --client -o json 2>/dev/null | jq -r '.clientVersion.gitVersion' | sed 's/^v//')
ok "kubectl $kubectl_version"

# Hostname resolution sanity check.
if ! grep -qE "^[^#]*\\b${FQDN}\\b" /etc/hosts; then
  warn "${FQDN} not in /etc/hosts. Add: '127.0.0.1 ${FQDN}' before running 'make up' from ops/"
else
  ok "${FQDN} present in /etc/hosts"
fi

ok "preflight passed"
