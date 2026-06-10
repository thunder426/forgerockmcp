#!/usr/bin/env bash
set -euo pipefail

NS="${NAMESPACE:-identity}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

POD=$(kubectl -n "$NS" get pod -l app=idm -o jsonpath='{.items[0].metadata.name}')
if [ -z "$POD" ]; then
  echo "no IDM pod found in namespace $NS" >&2
  exit 1
fi

echo "patching $NS/$POD authentication.json"
kubectl -n "$NS" cp "$SCRIPT_DIR/authentication.json" "$POD:/opt/openidm/conf/authentication.json" -c openidm

echo "done. IDM hot-reloads conf/ so no restart needed."
