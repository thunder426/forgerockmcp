# forgerockmcp

MCP server for Ping Identity (ForgeRock) AM that can list, build, modify, and delete authentication journeys (and the realms / identity stores / users they live in) — plus a reproducible local AM 8.1 / IDM 8.1 / DS 8.1 stack to develop and test against.

## Status

- **Stack**: working `make up` brings up AM/IDM/DS 8.1 on Minikube via ForgeOps 2025.2.1.
- **MCP server**: 26 tools live (journey CRUD + node CRUD + realms + identity stores + users), with a static-secret auth gate.
- **Agent skills**: not yet populated. See `agent/skills/`.

**For the verified working setup sequence, see [docs/local-stack-setup.md](docs/local-stack-setup.md).**

## Layout

Three folders, intentionally independent:

```
forgerockmcp/
├── ops/                          # local stack bringup; talks to neither side at runtime
│   ├── Makefile
│   ├── scripts/
│   │   ├── install-deps.sh, preflight.sh, up.sh, down.sh, destroy.sh
│   │   ├── bootstrap-mcp-admin.sh   # creates mcp-admin; writes AM_ADMIN_PASSWORD into mcp-server/env/.env
│   │   ├── gen-token.sh             # generates the shared MCP secret; writes BOTH halves
│   │   ├── smoke.sh, lib.sh
│   ├── env/.env(.example)        # NAMESPACE, FQDN, MINIKUBE_*, FORGEOPS_REF, MCP_ADMIN_*
│   └── .cache/forgeops/          # cloned at first run, gitignored
├── mcp-server/                   # the MCP server; ship to whatever runs the server
│   ├── src/, dist/, package.json
│   └── env/.env(.example)        # AM_BASE_URL, AM_ADMIN_PASSWORD, MCP_SERVER_TOKEN
├── agent/                        # the agent side; ship to whatever runs the agent
│   ├── env/.env(.example)        # FORGEROCK_AGENT_TOKEN (matches MCP_SERVER_TOKEN)
│   └── skills/                   # to be populated (explain-tree, create-tree, etc.)
└── docs/                         # cross-cutting docs
```

The MCP server NEVER reads `agent/env/.env` or `ops/env/.env`. Cross-folder writes happen one-way at install time (ops populates the other two), modeling a real prod handoff. The `.env` files are gitignored; `.env.example` shows what each side needs.

## Prerequisites (one-time)

Homebrew is required (`brew --version`; if missing, install from https://brew.sh).

```bash
cd ops
make install        # minikube, kubectl, kustomize, helm, jq, bash, python, OrbStack
```

Open OrbStack once after install so it can grant itself permissions for the docker daemon (Minikube's docker driver talks to that daemon).

Add the platform hostname to `/etc/hosts`:

```
127.0.0.1 forgeops.example.com
```

Configure each folder's env (copy the examples, then edit):

```bash
cp ops/env/.env.example         ops/env/.env
cp mcp-server/env/.env.example  mcp-server/env/.env
cp agent/env/.env.example       agent/env/.env
```

## Bring up the stack and wire the MCP

```bash
cd ops
make preflight    # verify tooling + /etc/hosts
make up           # ~5-10 min the first time (image pulls dominate)
make bootstrap    # create mcp-admin user; ALSO writes AM_ADMIN_PASSWORD into mcp-server/env/.env
make token        # generate the shared MCP secret; writes BOTH mcp-server/env/.env and agent/env/.env
make smoke        # confirm AM + IDM + journey API are working
```

Then build the server:

```bash
cd ../mcp-server
npm install && npm run build
```

Wire the MCP server into your host (e.g. `~/.claude.json`) pointing `command` at `mcp-server/dist/index.js`. The server reads its own `mcp-server/env/.env`, so the host's `env` block can be empty for AM creds — but the agent still needs to pass `_authToken` (the value in `agent/env/.env`) on every tool call.

Expected resource use: 4 vCPU, ~10 GB RAM, ~30 GB disk. The `up` step takes a while on first run because Minikube has to pull AM/IDM/DS/amster images (~3 GB total).

### Running the server over HTTP instead of stdio

The same binary can run as an HTTP server (useful for sharing one server across sessions, or for testing the prod-shaped transport):

```bash
cd mcp-server
npm run start:http      # binds to 127.0.0.1:8765, /mcp endpoint
# or with custom port/host:
node dist/index.js --http --port 9000 --host 127.0.0.1
```

Default binds to `127.0.0.1` only (not LAN-reachable) and the SDK's DNS-rebinding protection is on automatically. Server reads `mcp-server/env/.env` exactly the same way — including `MCP_SERVER_TOKEN`. The agent must still pass `_authToken` on every call.

Point your MCP host at it instead of spawning the binary. In `~/.claude.json`, the forgerock entry becomes:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8765/mcp"
}
```

Reload the window. Stdio mode and HTTP mode are mutually exclusive in the host config, but the same server binary supports both — pick at launch time with the `--http` flag.

## Useful URLs (after `make up`)

| URL | Purpose |
|---|---|
| `https://forgeops.example.com/am` | AM admin console |
| `https://forgeops.example.com/admin` | IDM admin console |
| `https://forgeops.example.com/enduser` | End-user UI (registration, profile, forgot-password) |
| `https://forgeops.example.com/login` | Platform login UI (journey runner) |

```bash
cd ops && make passwords    # print the generated amadmin / openidm-admin passwords
```

The cert is self-signed — browsers will warn. `curl` examples in scripts use `-k`.

## Tearing down

```bash
cd ops
make down       # delete the identity namespace (PVCs included) — keeps Minikube + image cache
make destroy    # nuke the Minikube profile entirely
```

## Troubleshooting

**`make preflight` complains about /etc/hosts** — add `127.0.0.1 forgeops.example.com` (or whatever you set `FQDN` to in `ops/env/.env`).

**`forgeops install` hangs on "Waiting for AM pod"** — `kubectl describe pod -l app.kubernetes.io/name=am` and `kubectl logs -l app.kubernetes.io/name=amster --tail=200`. Most common cause: amster job failed to apply the AM config because DS isn't ready yet. Re-run `make up` — it's idempotent.

**ImagePullBackOff** — verify you can pull manually: `docker pull us-docker.pkg.dev/forgeops-public/images-base/am:8.1.0`. These images are public-pull, no BackStage login required.

**Out of memory** — bump `MINIKUBE_MEMORY` in `ops/env/.env` to `12g` and `make destroy && make up`.

**MCP server refuses to start: "MCP_SERVER_TOKEN is required"** — run `cd ops && make token`. That generates the secret and writes it into both `mcp-server/env/.env` and `agent/env/.env` so they match.

**MCP tool call returns "Auth error: Missing _authToken"** — the agent isn't passing the token. The value is in `agent/env/.env` as `FORGEROCK_AGENT_TOKEN`; whatever drives the agent must include it as `_authToken` on every tool call.

**AM admin console "create user" returns LDAP error 21** — the console form sets `fr-idm-uuid` to the username, which DS rejects as a non-UUID. Use `mcp__forgerock__create_user` (POST `?_action=create` generates a proper UUID) or the IDM admin UI at `/admin`.
