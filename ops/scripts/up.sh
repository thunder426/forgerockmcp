#!/usr/bin/env bash
# Bring up the local Ping Identity Platform on Minikube via ForgeOps.
#
# Steps:
#  1. Clone the forgeops repo at the configured ref into .cache/forgeops
#  2. Start (or reuse) the Minikube profile with adequate resources
#  3. Create the target namespace
#  4. Run `forgeops install` with the platform overlay
#  5. Wait for the deployment to become ready
#
# Idempotent — safe to re-run.

source "$(dirname "$0")/lib.sh"

bash "$(dirname "$0")/preflight.sh"

# --- 1. forgeops checkout ---------------------------------------------------
if [[ ! -d "$FORGEOPS_PATH/.git" ]]; then
  log "Cloning forgeops@${FORGEOPS_REF} into ${FORGEOPS_DIR}"
  mkdir -p "$(dirname "$FORGEOPS_PATH")"
  # FORGEOPS_REF can be a branch (main, dev) or a tag (2025.2.1); --branch handles both.
  git clone --depth 1 --branch "$FORGEOPS_REF" \
    https://github.com/ForgeRock/forgeops.git "$FORGEOPS_PATH"
else
  log "Refreshing forgeops checkout at ${FORGEOPS_REF}"
  git -C "$FORGEOPS_PATH" fetch --depth 1 origin "tag" "$FORGEOPS_REF" 2>/dev/null \
    || git -C "$FORGEOPS_PATH" fetch --depth 1 origin "$FORGEOPS_REF"
  git -C "$FORGEOPS_PATH" checkout -q FETCH_HEAD
fi
ok "forgeops at $(git -C "$FORGEOPS_PATH" rev-parse --short HEAD)"

# --- 2. Minikube ------------------------------------------------------------
if ! minikube -p "$MINIKUBE_PROFILE" status >/dev/null 2>&1; then
  log "Starting Minikube profile '$MINIKUBE_PROFILE'"
  minikube start -p "$MINIKUBE_PROFILE" \
    --cpus="$MINIKUBE_CPUS" \
    --memory="$MINIKUBE_MEMORY" \
    --disk-size="$MINIKUBE_DISK" \
    --driver="$MINIKUBE_DRIVER" \
    --cni=true \
    --kubernetes-version=stable \
    --addons=ingress,volumesnapshots,metrics-server
else
  ok "Minikube profile '$MINIKUBE_PROFILE' already running"
fi

minikube -p "$MINIKUBE_PROFILE" profile "$MINIKUBE_PROFILE" >/dev/null
kubectl config use-context "$MINIKUBE_PROFILE" >/dev/null
ok "kubectl context: $(kubectl config current-context)"

# --- 3. Namespace -----------------------------------------------------------
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create ns "$NAMESPACE"
kubectl config set-context --current --namespace="$NAMESPACE" >/dev/null
ok "namespace '$NAMESPACE' ready"

# --- 4. ForgeOps configure (one-time: installs python deps into the checkout) ---
# 'forgeops configure' provisions the CLI's python deps under .cache/forgeops/lib/dependencies.
if [[ ! -f "$FORGEOPS_PATH/lib/dependencies/.configured_version" ]]; then
  log "Running forgeops configure (first-time python dep install)"
  "$FORGEOPS_PATH/bin/forgeops" configure --break-system-packages
fi

# --- 5. Cluster prereqs (cert-manager, ingress-nginx, secret-agent) ---------
# 'forgeops prereqs' installs cert-manager, ingress-nginx, and secret-agent via helm.
# Workaround: the secret-agent v1.2.5 chart references gcr.io/kubebuilder/kube-rbac-proxy:v0.8.0,
# which Google deleted from gcr.io. We install secret-agent directly with a working override,
# then run prereqs (which sees secret-agent's CRD already exists and skips it).
if ! kubectl get crd secretagentconfigurations.secret-agent.secrets.forgerock.io >/dev/null 2>&1; then
  log "Installing secret-agent operator (with kube-rbac-proxy override)"
  helm upgrade secret-agent oci://us-docker.pkg.dev/forgeops-public/charts/secret-agent \
    --version v1.2.5 \
    --namespace secret-agent --create-namespace \
    --install --reset-values --wait --timeout 5m \
    --set 'tolerations[0].key=kubernetes.io/arch' \
    --set 'tolerations[0].effect=NoSchedule' \
    --set 'tolerations[0].operator=Exists' \
    --set 'kubeRbacProxy.image.repository=quay.io/brancz/kube-rbac-proxy' \
    --set 'kubeRbacProxy.image.tag=v0.22.0'
fi

log "Running forgeops prereqs (cert-manager + ingress)"
"$FORGEOPS_PATH/bin/forgeops" prereqs

# DS PVCs request storageClassName 'fast'. Minikube only ships 'standard'.
# Alias 'fast' to the same minikube-hostpath provisioner — fine for dev.
if ! kubectl get sc fast >/dev/null 2>&1; then
  log "Creating 'fast' storage class (alias for minikube-hostpath)"
  kubectl apply -f - <<'YAML'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: k8s.io/minikube-hostpath
reclaimPolicy: Delete
volumeBindingMode: Immediate
YAML
fi

# --- 6. ForgeOps apply ------------------------------------------------------
# Generates a fresh kustomize overlay under kustomize/overlay/$NAMESPACE
# (if one doesn't exist) wired to our FQDN, then kubectl-applies it.
# --skip-issuer because we don't run cert-manager ClusterIssuer here.
log "Running forgeops apply (this is the slow step — pulls ~3GB of images)"
if [[ ! -d "$FORGEOPS_PATH/kustomize/overlay/$NAMESPACE" ]]; then
  log "Generating overlay $NAMESPACE"
  "$FORGEOPS_PATH/bin/forgeops" env \
    --env-name "$NAMESPACE" \
    --fqdn "$FQDN" \
    --skip-issuer
fi
"$FORGEOPS_PATH/bin/forgeops" apply \
  --create-namespace \
  --namespace "$NAMESPACE" \
  --env-name "$NAMESPACE" \
  --fqdn "$FQDN"

# --- 7. Wait for readiness --------------------------------------------------
log "Waiting for AM, IDM, DS pods to be Ready"
# ForgeOps 2025.2.1 labels component pods app=<component> (app.kubernetes.io/name is
# 'identity-platform' for all of them). Wait on app=<component>, and tolerate the pod
# not existing yet (kubectl wait errors immediately on a zero-match selector).
wait_ready() {
  local sel="$1" timeout="$2"
  for _ in $(seq 1 30); do
    kubectl get pod -l "$sel" -n "$NAMESPACE" 2>/dev/null | grep -q . && break
    sleep 5
  done
  kubectl wait --for=condition=ready pod -l "$sel" -n "$NAMESPACE" --timeout="$timeout"
}
wait_ready app=am 15m
wait_ready app=idm 10m
wait_ready app=ds-idrepo 10m

ok "Stack is up. Next steps:"
cat <<EOF

  • AM admin console:  https://${FQDN}/am  (login: ${AM_ADMIN_USER} / see below)
  • IDM admin console: https://${FQDN}/admin
  • End-user UI:       https://${FQDN}/enduser

  Retrieve generated passwords:
    kubectl get secret am-env-secrets   -n ${NAMESPACE} -o jsonpath='{.data.AM_PASSWORDS_AMADMIN_CLEAR}' | base64 -d; echo
    kubectl get secret idm-env-secrets  -n ${NAMESPACE} -o jsonpath='{.data.OPENIDM_ADMIN_PASSWORD}'    | base64 -d; echo

  Next (run from the ops/ folder):
    make bootstrap   # create the dedicated MCP admin user (also writes AM_ADMIN_PASSWORD into mcp-server/env/.env)
    make token       # generate the shared MCP token, writes both halves
    make smoke       # verify AM + IDM + journey APIs
EOF
