#!/usr/bin/env bash
# Tear down the namespace (keeps Minikube + cached images so re-up is fast).
# Use ops/scripts/destroy.sh to also delete the Minikube profile.

source "$(dirname "$0")/lib.sh"

log "Deleting namespace ${NAMESPACE} (PVCs included)"
kubectl delete ns "$NAMESPACE" --ignore-not-found --wait=true
ok "namespace removed"
