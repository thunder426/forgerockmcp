# Local ForgeRock Platform Setup — Verified Working Steps

This is the **tested, working** sequence to stand up a local Ping Identity Platform (AM 8.1, IDM 8.1, DS 8.1) for developing the MCP server against. Every step here was validated end-to-end on macOS 26.4 (Apple Silicon) with OrbStack as the container runtime.

This guide assumes the reader (human or agent) has never run this stack before. Follow it linearly. The order matters.

---

## Target end state

When done, you'll have:

- A Minikube cluster running AM, IDM, DS-idrepo, DS-cts, the three UIs, cert-manager, ingress-nginx, and secret-agent
- AM serving `https://forgeops.example.com/am` with 9 default journeys (Login, Registration, ResetPassword, etc.)
- IDM serving `https://forgeops.example.com/openidm/*`
- A persisted `MCP_ADMIN_PASSWORD` in `env/local/.env`
- All four `make` lifecycle commands working: `up`, `bootstrap`, `smoke`, `down`

Total time, cold: ~15 min (dominated by ~3 GB image pulls). Warm re-bring-up: ~3 min.

---

## Prerequisites

- macOS 14+ on Apple Silicon (Intel works the same way; image arch auto-selects)
- Homebrew installed (`brew --version` confirms)
- Local sudo access (only used once, by `minikube tunnel`)
- ~10 GB free disk; the Minikube VM grows to ~5–7 GB
- A laptop with at least 16 GB RAM (8 GB-class machines won't fit AM + IDM + DS comfortably even at minimum)

The Ping/ForgeRock container images on `us-docker.pkg.dev/forgeops-public/images-base/*` are **public-pull**. No BackStage/PingOne credentials are required.

---

## Step 1 — Install dependencies

```bash
cd /path/to/forgerockmcp     # the repo root
make install
```

This is a thin wrapper around `brew install` that pulls:

- `minikube`, `kubectl`, `kustomize`, `helm`, `jq`, `bash` (5.x; macOS ships 3.x which won't work), `python@3.13`
- OrbStack (cask)

Idempotent. If a tool is already installed it's a no-op.

### Post-install (manual, can't be scripted)

1. **Open OrbStack once** so it can install its helper and start the docker daemon. You'll get a single permissions prompt; no other UI interaction needed.
2. **Add the platform hostname to `/etc/hosts`** (requires `sudo`):
   ```bash
   sudo sh -c 'echo "127.0.0.1 forgeops.example.com" >> /etc/hosts'
   ```
3. **Copy and edit the env file:**
   ```bash
   cp env/local/.env.example env/local/.env
   ```
   The default values work. The one knob to consider: `MINIKUBE_MEMORY`. Default is `7000m` which is the floor that still runs the platform. If your Mac has ≥32 GB RAM, raise OrbStack's VM memory (Settings → System) above 12 GB and bump this to `10g` for headroom.

### Verify

```bash
docker info | head -5          # should report "Context: orbstack"
docker run --rm hello-world    # should print "Hello from Docker!"
```

If `docker info` errors out, OrbStack isn't fully started yet — open the OrbStack app.

---

## Step 2 — Preflight

```bash
make preflight
```

Checks every required CLI, that the docker daemon is reachable, and that `forgeops.example.com` is in `/etc/hosts`. All green is required before proceeding.

---

## Step 3 — Bring up the stack

```bash
make up
```

This does, in order:

1. Clones `github.com/ForgeRock/forgeops@2025.2.1` into `.cache/forgeops/`. (Note: `2025.2.1` is a **tag**, not a branch. Earlier hand-coded `2025.1` won't work — that's neither a branch nor a tag.)
2. Starts Minikube profile `forgerockmcp` with the docker driver and the `ingress` addon.
3. Runs `forgeops configure --break-system-packages` (provisions the forgeops CLI's Python deps into `.cache/forgeops/lib/dependencies/`).
4. Installs the **secret-agent** Helm chart with a manual override:
   ```bash
   --set kubeRbacProxy.image.repository=quay.io/brancz/kube-rbac-proxy
   --set kubeRbacProxy.image.tag=v0.22.0
   ```
   **Why the override:** the secret-agent v1.2.5 chart hardcodes `gcr.io/kubebuilder/kube-rbac-proxy:v0.8.0`, but Google deleted the entire `gcr.io/kubebuilder/*` namespace years ago. Without this override, the secret-agent pod stays in `ImagePullBackOff` forever, and Helm rolls back with `context deadline exceeded`. This is an upstream bug in the secret-agent chart that we work around.
5. Runs `forgeops prereqs` (cert-manager + nginx ingress; secret-agent is already there from step 4).
6. **Creates a `fast` StorageClass** that aliases to Minikube's `k8s.io/minikube-hostpath` provisioner. DS PVCs request `storageClassName: fast` (a holdover from ForgeOps's cloud profiles that expect SSD); Minikube only ships `standard`, so without this alias both DS pods stay `Pending` forever with `storageclass.storage.k8s.io "fast" not found`.
7. Generates a kustomize overlay (`forgeops env --skip-issuer --env-name identity`). `--skip-issuer` is critical — without it, the command prompts interactively for ClusterIssuer config and hangs in non-TTY contexts.
8. `forgeops apply` — kubectl-applies the overlay. Pulls ~3 GB of images.

**Expected timing on a warm-image-cache machine:** ~5 min. **Cold:** ~10–15 min, mostly the AM image pull (~600 MB).

### What healthy looks like

```bash
kubectl get pods -n identity
```

```
NAME                           READY   STATUS      RESTARTS   AGE
admin-ui-...                   1/1     Running     0          ...
am-...                         1/1     Running     0          ...
amster-...                     0/1     Completed   0          ...    # bootstrap job
ds-cts-0                       1/1     Running     0          ...
ds-idrepo-0                    1/1     Running     0          ...
ds-set-passwords-...           0/1     Completed   0          ...    # one-shot
end-user-ui-...                1/1     Running     0          ...
idm-...                        1/1     Running     0          ...
login-ui-...                   1/1     Running     0          ...
```

`amster` and `ds-set-passwords` should be `Completed`, not Running. If `amster` is still `Init:0/1` after 10 min, see Troubleshooting.

---

## Step 4 — Start the ingress tunnel

`minikube tunnel` is the bridge that makes `https://forgeops.example.com` (which resolves to `127.0.0.1`) actually reach the Minikube node IP (`192.168.49.2`, on Docker's internal bridge network and not directly accessible from macOS).

**In a separate terminal**, run:

```bash
minikube tunnel -p forgerockmcp
```

You'll be prompted once for your sudo password (it binds to ports 80/443). After authentication, **the tunnel command often produces no further output**. That's normal — it's not stuck, it's running. Don't close that terminal.

### Verify the tunnel

```bash
curl -sk https://forgeops.example.com/am/json/serverinfo/\* | jq .cookieName
```

Expected: `"iPlanetDirectoryPro"`.

If you get a connection refused or hang, the tunnel isn't running properly. Double-check the separate terminal — if it exited, restart it and re-enter sudo.

---

## Step 5 — Bootstrap the MCP admin user

```bash
make bootstrap
```

Creates the `mcp-admin` user in AM and persists its generated password to `env/local/.env`. Idempotent — re-running resets the password if the user already exists.

### Key implementation details (so the next reader doesn't trip on the same things)

1. **Realm is `root`, not `alpha`.** The default ForgeOps 2025.2 overlay only configures the root realm. The `etc/realm-config/.../root-alpha/` files in the forgeops repo exist but are not imported by the demo amster job. Creating an empty `alpha` realm via REST gives you a realm with no identity store, where you can't create users. So we stick with root for now.

2. **Don't PUT users by username.** The platform-shared DS includes the IDM-required `fr-idm-uuid` attribute, which DS strictly validates as a 36-byte UUID. If you do `PUT /users/mcp-admin`, AM sets `fr-idm-uuid=mcp-admin` and DS rejects with `Invalid Attribute Syntax`. Use `POST /users?_action=create` instead so AM auto-generates the UUID.

3. **Query by `uid`, not `username`.** AM's REST exposes `username` as a virtual attribute. `_queryFilter=username eq "..."` silently returns empty. Use `_queryFilter=uid eq "..."` to look up the user.

4. **Strong-looking passwords still fail policy.** The DS password validator rejects passwords like `McpAdmin#Local2026!Strong` for non-obvious reasons (possibly dictionary words inside the password). `openssl rand -base64 24 | tr -d '+/='` style passwords reliably pass. The script generates these automatically.

5. **`ui-realm-admin` privilege grant is best-effort.** The `addMember` call against `/groups/ui-realm-admin` succeeds, but `mcp-admin` still gets 403 on `/realm-config/*` endpoints. In AM 8, "ui-realm-admin" is a role/privilege managed via AM's delegation config, not via REST-accessible groups. Audit separation is a known TODO — for now the MCP server should use `amadmin`, fetched from the cluster secret.

### Verify

```bash
source env/local/.env
curl -sk -X POST "https://forgeops.example.com/am/json/realms/root/authenticate" \
  -H "Content-Type: application/json" \
  -H "X-OpenAM-Username: $MCP_ADMIN_USER" \
  -H "X-OpenAM-Password: $MCP_ADMIN_PASSWORD" \
  -H "Accept-API-Version: resource=2.0, protocol=1.0" \
  -d '{}' | jq .tokenId
```

Should return a non-null token string.

---

## Step 6 — Smoke test

```bash
make smoke
```

Hits AM (`serverinfo`, login as amadmin, list journeys), confirms mcp-admin can authenticate, then pings IDM.

### What healthy output looks like

```
▶ AM serverinfo
{
  "cookieName": "iPlanetDirectoryPro",
  "domains": null,
  "realm": "/"
}
▶ Login as amadmin
✓ logged in as amadmin
▶ List authentication trees (journeys) in realm 'root'
{
  "resultCount": 9,
  "journeys": [
    "ResetPassword", "Agent", "amsterService", "Registration",
    "ldapService", "ProgressiveProfile", "ForgottenUsername",
    "UpdatePassword", "Login"
  ]
}
▶ Check that mcp-admin can authenticate (smoke for bootstrap success)
✓ mcp-admin login OK (privileges TBD — currently only end-user level)
▶ IDM ping
{
  "_id": "",
  "_rev": "",
  "shortDesc": "OpenIDM ready",
  "state": "ACTIVE_READY"
}
✓ smoke tests passed
```

If you get this output, **everything works**. You're ready to develop against the platform.

---

## Useful URLs

After `make up` + minikube tunnel:

| URL | Purpose | Login |
|---|---|---|
| `https://forgeops.example.com/am` | AM admin console | `amadmin` / `make passwords` |
| `https://forgeops.example.com/admin` | IDM admin UI | `openidm-admin` / `make passwords` |
| `https://forgeops.example.com/enduser` | End-user UI (registration, profile, forgot password) | end users |
| `https://forgeops.example.com/login` | Platform login UI (journey runner) | end users |

The certs are self-signed — browsers will warn. `curl -k` and scripts ignore.

```bash
make passwords    # prints amadmin and openidm-admin passwords
```

---

## Lifecycle commands

```bash
make ps           # kubectl get pods in identity namespace
make logs         # tail AM pod logs
make passwords    # print amadmin and openidm-admin passwords
make down         # delete the identity namespace (keeps Minikube + image cache; fast re-up)
make destroy      # nuke the Minikube profile entirely (full cold start next time)
```

---

## Troubleshooting

### `make up` says `Remote branch 2025.1 not found in upstream origin`

You have an old `FORGEOPS_REF=2025.1` in `env/local/.env`. The forgeops repo uses tags like `2025.2.1`, not a `2025.1` branch. Fix:
```bash
sed -i '' 's/^FORGEOPS_REF=.*/FORGEOPS_REF=2025.2.1/' env/local/.env
```

### `Docker Desktop has only Xmb memory but you specified Yyy`

OrbStack's VM is smaller than the `MINIKUBE_MEMORY` value. Two options:
- **Raise OrbStack's RAM**: OrbStack → Settings → System → Memory. Then `make destroy && make up`.
- **Shrink Minikube**: edit `env/local/.env`, set `MINIKUBE_MEMORY=7000m` and `MINIKUBE_CPUS=3`. Tight but works.

### `forgeops not configured, please run forgeops configure`

`make up` does this automatically, but if you ran a forgeops command manually first:
```bash
.cache/forgeops/bin/forgeops configure --break-system-packages
```

### `Unable to find image 'us-docker.pkg.dev/engineering-devops/images/repo:latest'`

That's the **forgeops repo's** top-level Makefile (it wraps everything in a private CI container we can't pull). Cause: you ran `make` from inside `.cache/forgeops/` instead of from the repo root. Fix: always run `make <target>` from `/path/to/forgerockmcp`.

### `pod has unbound immediate PersistentVolumeClaims` on `ds-idrepo` / `ds-cts`

The `fast` StorageClass isn't there. `make up` creates it; if it's missing somehow:
```bash
kubectl apply -f - <<'YAML'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: k8s.io/minikube-hostpath
reclaimPolicy: Delete
volumeBindingMode: Immediate
YAML
```

### `secret "am-passwords" not found` (or `ds-passwords`, `amster`, `idm`, `ds-ssl-keypair`)

The secret-agent operator hasn't generated the secrets. Two sub-causes:
1. **secret-agent pod isn't running** — `kubectl get pods -n secret-agent`. If `ImagePullBackOff` on `secret-agent-kube-rbac-proxy`, the override didn't apply. Reinstall manually:
   ```bash
   helm uninstall -n secret-agent secret-agent
   helm upgrade secret-agent oci://us-docker.pkg.dev/forgeops-public/charts/secret-agent \
     --version v1.2.5 --namespace secret-agent --create-namespace \
     --install --reset-values --wait --timeout 5m \
     --set 'tolerations[0].key=kubernetes.io/arch' \
     --set 'tolerations[0].effect=NoSchedule' \
     --set 'tolerations[0].operator=Exists' \
     --set 'kubeRbacProxy.image.repository=quay.io/brancz/kube-rbac-proxy' \
     --set 'kubeRbacProxy.image.tag=v0.22.0'
   ```
2. **SecretAgentConfiguration wasn't applied** (because the CRD wasn't there when `forgeops apply` first ran). Re-apply just the secrets piece:
   ```bash
   kubectl apply -k .cache/forgeops/kustomize/overlay/identity/secrets -n identity
   ```

### `make up` hangs on `Continue using a ClusterIssuer called "default-issuer"?`

The `forgeops env` overlay generator wants interactive input. Make sure `up.sh` passes `--skip-issuer`. If a previous failed run left a partial overlay, delete it:
```bash
rm -rf .cache/forgeops/kustomize/overlay/identity .cache/forgeops/helm/identity
```
then `make up` again.

### `curl: connection refused` on `https://forgeops.example.com`

`minikube tunnel` isn't running. Check the separate terminal — it may have exited (sudo session expired, or you closed the window). Restart it.

### LDAP `errorcode=21` when creating a user via AM REST

You PUT the user by username (`PUT /users/mcp-admin`), which makes AM try to set `fr-idm-uuid=mcp-admin` and DS rejects. Use `POST /users?_action=create` instead. The bootstrap script does this correctly.

### Password rejected with `did not meet the password policy requirements`

Use a generated random password: `openssl rand -base64 24 | tr -d '+/=' | head -c 24`. Patterns that look strong to humans often fail DS's validator (likely due to substring dictionary checks).

### `mcp-admin login OK` but journey list returns 403 Forbidden

Expected for now. In AM 8 the `ui-realm-admin` privilege isn't grantable via REST `addMember`; it requires editing AM's delegation policy via the admin console UI. The MCP server uses `amadmin` until we tackle proper realm + privilege configuration. Known limitation, documented in the smoke script comments.

---

## Things this guide does NOT cover (yet)

- Configuring a proper sub-realm with a wired identity store (so `mcp-admin` can be a real least-privilege admin).
- Wiring AM's delegation policy to grant the journey-config privilege to a non-amadmin user.
- IDM managed object setup beyond what ForgeOps ships.
- Importing/exporting AM config bundles via amster outside of the initial bootstrap.
- Backing up the DS data PVCs.

These will be tackled in Phase 2+ as the MCP server tools require them.

---

## Quick reference (cheat sheet)

```bash
# First time
make install
sudo sh -c 'echo "127.0.0.1 forgeops.example.com" >> /etc/hosts'
# Open OrbStack once
cp env/local/.env.example env/local/.env
make preflight && make up
# In a separate terminal: minikube tunnel -p forgerockmcp
make bootstrap && make smoke

# Daily
# Already-built cluster, just need the tunnel:
minikube tunnel -p forgerockmcp                 # separate terminal
make ps                                          # check pods are happy

# Reset
make down                                        # clear namespace, keep cluster
make up                                          # rebuild platform

# Nuclear
make destroy                                     # delete Minikube profile entirely
make up                                          # cold rebuild (~15 min)
```
