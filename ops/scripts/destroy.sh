#!/usr/bin/env bash
# Nuke the Minikube profile entirely. The forgeops checkout in .cache/ stays.

source "$(dirname "$0")/lib.sh"

log "Deleting Minikube profile ${MINIKUBE_PROFILE}"
minikube delete -p "$MINIKUBE_PROFILE"
ok "destroyed"
