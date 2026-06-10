# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

Three folders, each independently deployable:

1. **[ops/](ops/)** — local Ping Identity (ForgeRock) stack: scripts under [ops/scripts/](ops/scripts/) that bring up AM 8.1 / IDM 8.1 / DS 8.1 on Minikube via the upstream `forgeops` overlay. Also bootstraps the mcp-admin user and writes the AM admin password into the server's dotenv.
2. **[mcp-server/](mcp-server/)** — Node/TypeScript MCP server that exposes ForgeRock AM journey-management tools to an agent. Reads its own dotenv at [mcp-server/env/.env](mcp-server/env/.env). Currently exposes 26 tools (journeys CRUD + node CRUD + realms + identity stores + users).
3. **[agent/](agent/)** — agent-side artifacts: skills (TBD) and the agent's copy of the shared MCP secret in [agent/env/.env](agent/env/.env).

The split exists because in production the three would run on different hosts owned by different teams. We mirror that split locally so the boundary is architectural, not just convention. Each folder's `env/.env` is private to that folder; the only legitimate cross-folder write is ops/ populating mcp-server/env/.env at install time.

The authoritative setup walkthrough (every gotcha + fix) is [docs/local-stack-setup.md](docs/local-stack-setup.md). Read it before debugging stack issues.

## Common commands

### Local stack — run from [ops/](ops/)

| Command | What |
|---|---|
| `make install` | brew-install minikube/kubectl/kustomize/helm/jq/bash/python + OrbStack (one-time) |
| `make preflight` | verify CLIs and `/etc/hosts` (needs `127.0.0.1 forgeops.example.com`) |
| `make up` | start Minikube + run `forgeops install` (~5–10 min first run, idempotent — safe to re-run) |
| `make bootstrap` | create the `mcp-admin` user; **also writes AM_ADMIN_PASSWORD into mcp-server/env/.env** |
| `make token` | generate the shared MCP secret; writes both halves (mcp-server + agent) |
| `make smoke` | AM login + journey list + IDM ping |
| `make passwords` | print generated `amadmin` / `openidm-admin` passwords from the k8s secrets |
| `make ps` / `make logs` | `kubectl get pods` / tail AM pod logs in the `identity` namespace |
| `make down` | delete the namespace (PVCs included), keep Minikube |
| `make destroy` | nuke the Minikube profile entirely |

Stack/cluster knobs (NAMESPACE, FQDN, MINIKUBE_*, FORGEOPS_REF, MCP_ADMIN_*) live in [ops/env/.env](ops/env/.env). Server-side runtime config lives in [mcp-server/env/.env](mcp-server/env/.env). Agent-side config lives in [agent/env/.env](agent/env/.env).

### MCP server — run from [mcp-server/](mcp-server/)

| Command | What |
|---|---|
| `npm run build` | `tsc` → `dist/` (the MCP host runs `dist/index.js`, so build before reload) |
| `npm run dev` | `tsx --watch src/index.ts` for iteration |
| `npm run typecheck` | `tsc --noEmit` |
| `npm start` | `node dist/index.js` (stdio; rarely useful directly — run via the MCP host) |
| `npm run start:http` | `node dist/index.js --http` — HTTP server on `127.0.0.1:8765/mcp` |

There is no test runner wired up yet.

## Architecture

### Folder boundary

The three folders never read each other's dotenv at runtime:

- **mcp-server's loader** (`config.ts`) only resolves `mcp-server/env/.env`.
- **ops scripts** read `ops/env/.env`. They do *write* into `mcp-server/env/.env` at install time (AM_ADMIN_PASSWORD) and into both server + agent envs (gen-token), but that's a one-way ops → runtime handoff that mirrors how a real prod operator would provision both sides.
- **agent** reads `agent/env/.env` (currently consumed only by the agent's own MCP-host config, not by code in this repo).

Cross-folder reads at runtime would be a security regression — we want to be able to ship `mcp-server/` to a server and `agent/` to a different machine without dragging the other folder along.

### Stack bring-up flow

`make up` (from ops/) clones `github.com/ForgeRock/forgeops` at the tag in `FORGEOPS_REF` into `ops/.cache/forgeops/`, starts Minikube with the `docker` driver against OrbStack's daemon, creates the `identity` namespace, and runs `forgeops install` against the platform overlay. That overlay deploys the secret-agent operator (which generates AM/IDM admin passwords + AM↔IDM OAuth client secrets), then `ds-idrepo`, `ds-cts`, `am`, the `amster` bootstrap job, `idm`, and the UIs. `make bootstrap` then creates a dedicated `mcp-admin` user — a session-token user, not an OAuth2 client, because AM's `realm-config/*` endpoints (where journeys live) only accept session tokens. See [docs/auth-design.md](docs/auth-design.md).

### MCP server design

[mcp-server/src/index.ts](mcp-server/src/index.ts) is a small registry: each tool is `{ name, permission, description, inputSchema, handler }`. `permission` is `"read"` or `"write"`. `ListTools` and `CallTool` handlers iterate the array. Adding a new tool = add a file under `src/tools/`, export `<name>Input` (Zod) + handler, register in `index.ts` with a permission tag.

The Server is built by a `buildServer()` factory so each transport gets its own instance. **Stdio is the default** (matches how MCP hosts spawn the binary as a child process). **`--http` runs the same code over HTTP** on `127.0.0.1:8765/mcp` (override with `--port`/`--host` or `MCP_HTTP_PORT`/`MCP_HTTP_HOST`). HTTP mode is *stateless*: a fresh `Server` + `StreamableHTTPServerTransport` per request, which matches our per-call-token auth model and trivially scales horizontally if we ever need that. The SDK's `createMcpExpressApp` is used so DNS-rebinding protection is on automatically when bound to a localhost address.

[mcp-server/src/am/client.ts](mcp-server/src/am/client.ts) is the AM REST client:

- **Session-token auth, not OAuth2.** It logs in once via `/json/realms/root/authenticate` (using the `X-OpenAM-Username` / `X-OpenAM-Password` headers), caches the `tokenId`, and re-authenticates once on a 401.
- **Realm path encoding** — AM nests realms as `root/realms/<name>`; root alone is just `root`. Always use `realmPath()`.
- **Self-signed TLS** — when `AM_INSECURE_TLS=true` an undici `Agent` with `rejectUnauthorized:false` is used. Local dev only.

`AmError` carries `status` + parsed `body`; the `CallTool` handler formats it as `AM error <status>: <body>`.

**stdout is the MCP transport — never `console.log` in server code.** Diagnostics go to stderr.

### Auth gate

[mcp-server/src/auth.ts](mcp-server/src/auth.ts) wraps every tool call. Two modes selected by `MCP_AUTH_MODE`:

- **`static` (default)**: server validates each call's `_authToken` against `MCP_SERVER_TOKEN` with a constant-time compare. The agent must independently know the same value (stored on its side as `FORGEROCK_AGENT_TOKEN` in agent/env/.env) and pass it as `_authToken` on every call.
- **`oauth-am` (NOT IMPLEMENTED)**: stubbed; will introspect each call's bearer against AM and check `forgerock.read` / `forgerock.write` scope.
- **`disabled`**: bypass for tests; requires `MCP_AUTH_DISABLED_ACK=true` to confirm.

Server boot fails fast with a clear error if `MCP_SERVER_TOKEN` is missing in static mode. Per-tool tagging (read vs write) is in `index.ts`.

### Config loading

[mcp-server/src/config.ts](mcp-server/src/config.ts) exports `loadEnv()` (a Proxy that returns process.env first, then mcp-server/env/.env) and `loadConfig(env)` (typed AM config from that). Empty-string process.env values are treated as unset — `.mcp.json` substitutes `"${VAR}"` with `""` when `VAR` isn't in the shell, and we want the `.env` value to win in that case.

### MCP host wiring

Per repo memory: the MCP server is registered in `~/.claude.json` directly, not via this repo's `.mcp.json`. The `.mcp.json` here is a reference. The server reads `mcp-server/env/.env` itself, so secrets don't need to be in the host config — but the agent must still pass `_authToken` on every tool call.

## Gotchas

- **Rebuild after editing the server.** The MCP host runs `dist/index.js`; `npm run build` is mandatory before the next tool call sees changes.
- **Always `cd ops/` for `make` targets.** The Makefile lives there. Running `make` from the repo root won't find it.
- **`make up` is idempotent — re-run it** if the amster bootstrap job races DS readiness on first install.
- **OrbStack VM RAM ceiling.** `MINIKUBE_MEMORY` must fit inside OrbStack's VM (defaults to ~half of host RAM).
- **`ForgeOps 2025.2` default overlay only configures the `root` realm.** Use `mcp__forgerock__create_realm` to make `alpha`; the realm's `OpenDJ` identity store (`LDAPv3ForForgeRockIAM`) is auto-provisioned at realm-create time.
- **AM admin console "create user" form is broken** in this overlay (sends username as fr-idm-uuid → DS LDAP error 21). Use `mcp__forgerock__create_user` or the IDM admin UI at `/admin` instead.
- **AM /users PUT requires `userPassword` on every update** — `update_user` always rotates the password as a result. For non-rotating updates, use IDM (`/openidm/managed/user`); IDM tools TBD.
- **Token must match between sides.** If you change `MCP_SERVER_TOKEN` in mcp-server/env/.env you must also update `FORGEROCK_AGENT_TOKEN` in agent/env/.env. Use `make token` (from ops/) to rotate both atomically in dev.
