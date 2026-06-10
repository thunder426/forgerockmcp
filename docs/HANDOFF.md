# Project Handoff

Read this top-to-bottom before doing anything. It captures both what works
and the open loops. Last updated 2026-05-14 (added update-tree skill +
"Realm bootstrap gap" section).

For *current* commands and paths, [CLAUDE.md](../CLAUDE.md) is canonical and
this doc defers to it. This file is the *narrative*: how we got here, why
each decision, and what's still pending.

---

## Where we are

| Phase | Status |
|---|---|
| Local AM/IDM/DS stack | Done. `make up` from `ops/` is idempotent and works on a fresh machine. |
| MCP server (31 tools, 5 categories) | Done. Stdio + HTTP transports, both live-verified. |
| Auth gate (server-side validates per-call _authToken) | Done. Static-secret mode active; OAuth-via-AM stubbed. |
| Three-folder split (ops / mcp-server / agent) | Done. Each independently deployable. |
| Skills: explain-tree, create-tree | Done, with hand-curated reference files. |
| Skills: update-tree | Done. Sanity-walked against `MyLogin` through two non-trivial edits (add retry, then add email-OTP MFA + lazy email enrollment + later revert). Includes step-4b outcome-name validation as a hard gate. |
| Skills: simplify-tree, test-journey | Not started. |
| Frontend / IDM tools | Not started. |
| Realm bootstrap (close the four `/alpha` gaps) | Not started. See "Realm bootstrap gap" below. |

---

## Folder layout (current)

Three independently deployable folders. None reads another's `env/.env` at runtime.

```
forgerockmcp/
├── ops/                          # local stack bringup; "operator" side
│   ├── Makefile                  # install, preflight, up, bootstrap, token, smoke, node-catalog, ...
│   ├── scripts/                  # bash scripts the Makefile invokes
│   │   ├── lib.sh                # sources ops/env/.env; resolves OPS_ROOT, REPO_ROOT, SERVER_ENV_FILE, AGENT_ENV_FILE
│   │   ├── up.sh, down.sh, destroy.sh, preflight.sh, install-deps.sh, smoke.sh
│   │   ├── bootstrap-mcp-admin.sh   # creates mcp-admin; ALSO writes AM_ADMIN_PASSWORD into mcp-server/env/.env
│   │   ├── gen-token.sh             # generates MCP shared secret; writes BOTH halves
│   │   └── dump-node-catalog.sh     # regenerates agent/skills/_references/am-node-catalog.json
│   ├── env/.env(.example)        # NAMESPACE, FQDN, MINIKUBE_*, FORGEOPS_REF, MCP_ADMIN_*
│   └── .cache/forgeops/          # cloned forgeops repo, gitignored
├── mcp-server/                   # the MCP server only
│   ├── src/
│   │   ├── index.ts              # tool registry + transport switch (stdio default, --http opt-in)
│   │   ├── auth.ts               # Authenticator interface, StaticSecretAuthenticator (active), OAuthAmAuthenticator (stubbed)
│   │   ├── config.ts             # loadEnv() (process.env + mcp-server/env/.env), loadConfig()
│   │   ├── jsonSchema.ts         # minimal Zod → JSON Schema (no external dep)
│   │   ├── am/client.ts          # session-token AM REST client; realmGet/Post/Put/Delete + global*
│   │   └── tools/
│   │       ├── journeys.ts, nodes.ts, realms.ts, identityStores.ts, users.ts, scripts.ts
│   ├── env/.env(.example)        # AM_BASE_URL, AM_ADMIN_PASSWORD, MCP_SERVER_TOKEN, MCP_AUTH_MODE
│   ├── package.json              # add `start:http` for HTTP transport
│   └── dist/                     # build output, gitignored
├── agent/                        # agent-side artifacts
│   ├── env/.env(.example)        # FORGEROCK_AGENT_TOKEN (must equal mcp-server's MCP_SERVER_TOKEN)
│   └── skills/
│       ├── explain-tree/SKILL.md
│       ├── create-tree/SKILL.md
│       └── _references/
│           ├── am-node-catalog.json   # ~400KB, generated; 140 node types with config schema
│           ├── am-node-outcomes.md    # hand-curated outcome map + idioms + red flags + "Querying the references" recipes
│           └── am-tree-recipes.md     # 7 worked recipes (login, login+retry, registration, forgot-pw, forgot-username, progressive-profile, update-pw, SDN)
├── docs/
│   ├── local-stack-setup.md      # AUTHORITATIVE setup walkthrough
│   ├── auth-design.md            # why session-token, not OAuth2, for AM admin
│   └── HANDOFF.md                # this file
├── CLAUDE.md
├── README.md
└── .mcp.json                     # documentation only; real wiring is in ~/.claude.json
```

---

## Boot-from-scratch sequence (what a fresh machine needs)

```bash
# one-time
cd ops && make install                # brew, OrbStack, etc.
cp ops/env/.env.example         ops/env/.env
cp mcp-server/env/.env.example  mcp-server/env/.env
cp agent/env/.env.example       agent/env/.env
echo "127.0.0.1 forgeops.example.com" | sudo tee -a /etc/hosts

# stack bring-up
cd ops
make preflight
make up           # ~5-10 min first time; idempotent — re-run if amster races DS
make bootstrap    # creates mcp-admin in AM; writes AM_ADMIN_PASSWORD into mcp-server/env/.env
make token        # generates the MCP shared secret; writes both halves
make smoke

# server build
cd ../mcp-server
npm install && npm run build
```

Then wire `~/.claude.json` (see "MCP host wiring" below) and reload the
window. The agent now has 31 `mcp__forgerock__*` tools, gated by a static
secret it sends as `_authToken` on every call.

---

## MCP server: the 31 tools

Each tool is tagged `read` or `write` in `mcp-server/src/index.ts`. The
Authenticator gates `write` calls in OAuth mode (in static mode, every call
is gated identically — token must match).

| Category | Tools |
|---|---|
| Journeys | `list_journeys` (R), `get_journey` (R), `get_journey_terminals` (R), `create_journey` (W), `update_journey` (W), `delete_journey` (W), `edit_journey_edges` (W) |
| Nodes | `list_node_types` (R), `get_node_type_schema` (R), `list_nodes` (R), `list_all_nodes` (R), `get_node` (R), `upsert_node` (W), `delete_node` (W) |
| Realms | `list_realms` (R), `create_realm` (W), `delete_realm` (W) |
| Identity stores | `list_identity_store_types` (R), `list_identity_stores` (R), `configure_identity_store` (W), `delete_identity_store` (W) |
| Users | `list_users` (R), `get_user` (R), `create_user` (W), `update_user` (W), `delete_user` (W) |
| Scripts | `list_scripts` (R), `get_script` (R), `upsert_script` (W), `delete_script` (W), `list_script_contexts` (R) |

All tools were live-verified end-to-end against the alpha realm in the local stack.

### Why session tokens, not OAuth2 (for AM admin)

AM's `/realm-config/*` endpoints (where journeys, nodes, scripts, identity
stores live) only accept session tokens — not OAuth2 bearers. So the MCP
server logs into AM as `amadmin` once at startup, caches the `tokenId`, and
re-authenticates once on a 401. See `mcp-server/src/am/client.ts`. This is
about the server↔AM hop, not the agent↔server hop (which uses our own MCP
auth gate).

---

## MCP auth gate (agent ↔ server)

`mcp-server/src/auth.ts`. Three modes via `MCP_AUTH_MODE`:

- **`static`** (default, active): server validates each call's `_authToken`
  against `MCP_SERVER_TOKEN` (constant-time compare). Server refuses to boot
  if the token isn't set. Agent must independently know the same value as
  `FORGEROCK_AGENT_TOKEN` in `agent/env/.env` and pass it on every tool call.
- **`oauth-am`** (stubbed): planned shape — agent presents an OAuth2 bearer
  per call, server introspects via AM, scope-checks `forgerock.read` /
  `forgerock.write`. Class throws `NotImplemented`; ready to fill in.
- **`disabled`** (testing only): requires `MCP_AUTH_DISABLED_ACK=true`.

Server-side and agent-side tokens are deliberately stored in *different*
folders. The mcp-server reads `mcp-server/env/.env` only; never `agent/env/.env`.
ops/ is privileged enough to write into both at install/rotate time
(`make token`) — that's the one legitimate cross-folder write.

---

## Transports

`node dist/index.js` (stdio, default) — MCP host spawns the binary as a child
process; auth via `_authToken` in tool args.

`node dist/index.js --http` (or `npm run start:http`) — binds to
`127.0.0.1:8765/mcp`, stateless mode (a fresh `Server` + `StreamableHTTPServerTransport`
per request), DNS-rebinding protection on by default. Override with
`--port`/`--host` or `MCP_HTTP_PORT`/`MCP_HTTP_HOST`.

Both transports run the same `buildServer()` factory; auth gate is identical.
Live-verified four scenarios over HTTP (initialize, valid token, wrong token,
missing token) — all behave correctly.

For remote deployment: same binary in a Dockerfile, run with `--http`,
front with TLS, change `~/.claude.json` to `{"type":"http","url":"https://..."}`.
The auth model survives unchanged; secrets move from dotenv to k8s Secret /
systemd EnvironmentFile / etc.

---

## MCP host wiring

The `.mcp.json` discovery+approval flow never triggered cleanly in this VS
Code install, so the server is registered **directly in `~/.claude.json`**
under the project entry:

```json
"projects": {
  "/Users/leizhang/Documents/Personal/forgerockmcp": {
    "hasTrustDialogAccepted": true,
    "mcpServers": {
      "forgerock": {
        "type": "stdio",
        "command": "node",
        "args": ["/Users/leizhang/Documents/Personal/forgerockmcp/mcp-server/dist/index.js"],
        "env": {}
      }
    }
  }
}
```

`env: {}` is intentional — the server reads its own `mcp-server/env/.env`.
But the **agent** still has to know the shared secret somehow; the value
lives in `agent/env/.env` as `FORGEROCK_AGENT_TOKEN`. There's no automated
way to get the agent (Claude Code) to inject that into every `_authToken`
field today — it has to be told to do so as part of the conversation, or
via a skill instruction.

After editing `~/.claude.json`, **Reload Window** (Cmd+Shift+P → Developer:
Reload Window). The new MCP server appears as `mcp__forgerock__*` tools
without a restart.

For HTTP transport, swap to:
```json
{ "type": "http", "url": "http://127.0.0.1:8765/mcp" }
```

---

## Skills

Two skills currently. Both live in `agent/skills/<name>/SKILL.md`. They are
*procedure documents* the LLM reads — not code that calls MCP itself. The
agent following the skill makes the actual MCP calls.

### explain-tree

Read-only walkthrough of an AM tree. Process: clarify inputs → fetch tree →
expand opaque nodes (PageNode inner collectors, ScriptedDecisionNode source,
InnerTreeEvaluatorNode → recurse) → identify outcomes → walk paths →
red-flags pass. Output is a structured Markdown explanation with a
one-line summary, per-path narrative, notable details, and red flags.

Sanity-walked against alpha's seed `Login` tree. Output correctly identified:
- Login composes `ProgressiveProfile` (not MFA — important: my training-data
  guess was wrong, the live tree disagreed; updated the references).
- The PageNode wraps ValidatedUsername + ValidatedPassword (only visible by
  fetching the PageNode instance — outer graph hides it).
- **Red flag**: no rate-limiting between bad password and FAILURE.

### create-tree

Plan-first builder. Process: clarify intent (force-resolve realm, tree id,
success/failure, IDM side effects, sub-trees) → match a recipe in
`am-tree-recipes.md` → produce a Markdown plan with nodes table + edges +
"schema lookups still needed" → STOP for user confirmation → resolve
unknowns (jq the catalog, or `get_node_type_schema`) → build bottom-up
(callback collectors → PageNodes → decisions → tree) → verify with
explain-tree.

Sanity-walked against "login with retry limit, retryLimit=3". The
plan-first design caught a real bug: `RetryLimitDecisionNode` outcomes are
`Retry`/`Reject`, NOT `true`/`false`. My recipe and outcomes file both had
this wrong. Fixed.

### update-tree

Plan-as-diff modifier. Process: clarify intent → re-read the live tree
(`get_journey`) → produce a Markdown diff (Before / After slice + ops table +
orphaned-node list + risk-of-breakage) → STOP for "go" → **step 4b: validate
every outcome name in the diff against `am-node-outcomes.md`** (hard gate;
IDM CRUD emit `PATCHED`/`CREATED`/`FAILURE`, RetryLimit emits `Retry`/`Reject`,
not `outcome` / `true`/`false`) → apply bottom-up (new node bodies →
`edit_journey_edges` for rewires + adds + removes → `update_journey` scalars
→ optional `delete_node` cleanup) → verify with explain-tree, including a
`_rev` smoke check against the pre-edit revision.

Sanity-walked twice against `MyLogin`:

1. **Add 3-attempt retry limit** (Recipe 1 → 1b). One new node + one rewired
   edge. Clean run.
2. **Add stubbed email-OTP MFA + lazy email enrollment** (`Has Email?` →
   `Collect Email` → `Stub OTP` SDN → `Verify OTP` → `Save Email`). Six new
   nodes + script + reconfigured RetryLimit + edge rewires. Surfaced four
   real platform issues the skill caught cleanly:
   - The skill's "no schema-bypassed outcomes" rule caught `PatchObjectNode`
     wired with `outcome → SUCCESS` instead of `PATCHED → SUCCESS, FAILURE →
     FAILURE` — codified as step 4b.
   - AM 8 script sandbox blocks `java.lang.System.currentTimeMillis()` →
     swap to `Date.now()`. Both recipes.md and outcomes.md updated.
   - AM 8 script `context` value changed from `SCRIPTED_DECISION_NODE` (7.x)
     to `AUTHENTICATION_TREE_DECISION_NODE` (8.x). Documented in Recipe 7.
   - IDM-aware nodes (PatchObject / AttributePresent / AttributeCollector /
     IncrementLoginCount) all fail in this overlay because of the realm
     bootstrap gap — see "Realm bootstrap gap" below. The skill's diagnostic
     process (re-read → audit logs → minimal targeted edit) isolated this to
     a stack-config issue, not a tree-design one. `MyLogin` is now stripped
     to its non-IDM working shape: Login Form → Verify creds → Stub OTP →
     Verify OTP (with RetryLimit gating OTP attempts). End-to-end verified
     via curl: `testnomail` + password + OTP `000000` returns a real session
     `tokenId`. The IDM-aware nodes were `removeNodeIds`-d from the tree's
     map but their bodies remain in AM, so restoring them is a single
     `edit_journey_edges` call after the realm bootstrap lands.

### Reference files (`agent/skills/_references/`)

- **`am-node-catalog.json`** — generated by `cd ops && make node-catalog`.
  Hits AM, dumps all 140 node types with their `name`, `tags`, `help`, and
  `config` schema. ~400 KB / ~115K tokens. **Skills must NOT load this whole**
  — they query it with jq. Recipes are documented in the next file.
- **`am-node-outcomes.md`** — hand-curated. Three layers:
  1. Type-fixed outcomes (decision → true/false, IDM CRUD → CREATED/PATCHED/FAILURE,
     MFA / social / captcha / RetryLimit's Retry-Reject exception).
  2. Dynamic-outcome types (ChoiceCollector, ScriptedDecision, ConfigProvider,
     Consent — must inspect instance).
  3. Common idioms (login, registration, forgot-password, forgot-username,
     progressive-profile, MFA via inner tree, update-password) and 8 red-flag
     patterns. Plus a "Querying the references" section with jq recipes for
     keyword search, single-type schema, tag filter, recipes index.
- **`am-tree-recipes.md`** — 7 worked recipes (login, login+retry-limit,
  registration, forgot-password, forgot-username, progressive-profile,
  update-password, ScriptedDecisionNode). Each shows the full
  upsert_node calls + the create_journey payload with connections wiring.

### Cost-conscious retrieval

The skills tell the LLM to **not load the catalog whole** (~115K tokens
wasted on 140 types when a typical task touches 3-8). Instead, query with
jq via the `Bash` tool. Four documented recipes in `am-node-outcomes.md`'s
"Querying the references" section, all live-verified. Saves ~120K tokens
per session.

If/when the LLM gets clumsy with jq or you go to a remote agent without
shell access, the upgrade path is: shell-helper script in
`agent/skills/_helpers/` → MCP `search_node_types` tool. Same retrieval
semantics, different home.

---

## Important platform facts (don't re-discover)

1. **Realms in alpha**: only `root` exists by default in ForgeOps 2025.2.1.
   The `alpha` realm was created via `mcp__forgerock__create_realm`. When
   alpha is created, AM auto-provisions an `OpenDJ` identity store of type
   `LDAPv3ForForgeRockIAM` bound to `ds-idrepo-0:1636` (LDAPS), baseDN
   `ou=identities`. **Don't add a second one** — there's a related gotcha in
   `list_identity_stores` history.

2. **`list_identity_stores` cross-type list**: AM's per-type `_queryFilter`
   only returns nodes/stores of one type — silently hides others. Use
   `?_action=nextdescendents` instead. Both `list_identity_stores` and
   `list_all_nodes` use this; the per-type `list_nodes` exists for
   completeness but is rarely the right tool.

3. **AM admin console "create user" form is broken** in this overlay (sends
   username as `fr-idm-uuid` → DS LDAP error 21). Use
   `mcp__forgerock__create_user` (POST `?_action=create` generates a proper
   UUID) or the IDM admin UI at `/admin`.

4. **AM `/users` PUT requires `userPassword`** on every update — even when
   only changing unrelated attrs. So `update_user` always rotates the
   password. For non-rotating updates, IDM's `/openidm/managed/user` is the
   right path (no MCP tool yet).

5. **Tree PUT is full-replace** (not merge). `update_journey` and
   `edit_journey_edges` both read-mutate-write transparently.

6. **Tree-deletion cascades to nodes**: AM 8 deletes nodes that were
   referenced only by the deleted tree. Calling `delete_node` after
   `delete_journey` will 404. Tool descriptions reflect this.

7. **PageNode children are separate node records.** PageNode's
   `config.nodes` is `[{_id, displayName, nodeType}, ...]` — references to
   nodes you must `upsert_node` independently. Critical for create-tree;
   recipes and skill both call this out.

8. **Reserved terminal UUIDs are AM-wide constants**:
   `70e691a5-1e33-4ac3-a356-e7b6d60d92e0` (success),
   `e301438c-0bd0-429c-ab0c-66126501069a` (failure). Verified across realms
   and across freshly-created trees. `mcp__forgerock__get_journey_terminals`
   returns them at runtime.

9. **`staticNodes` is editor-only positioning** — null on REST-created trees,
   populated by the AM admin UI for the editor. Never rely on it for graph
   semantics.

10. **Scripts are base64 on the wire**, the tools (`upsert_script`,
    `get_script`) decode/encode transparently.

11. **ScriptedDecisionNode outcomes are declared on the SDN, not the script.**
    Same script can back multiple SDNs with different outcome arrays. Script
    sets `outcome = "<one of declared names>"`.

12. **`RetryLimitDecisionNode` outcomes are `Retry` / `Reject`** — NOT
    `true` / `false` like most decision nodes. Stored as a "decision nodes
    with custom outcome names" exception in `am-node-outcomes.md`.

13. **Image registry workarounds** baked into `ops/scripts/up.sh`:
    - secret-agent v1.2.5 hardcodes `gcr.io/kubebuilder/kube-rbac-proxy:v0.8.0`
      (deleted from gcr) → overridden to `quay.io/brancz/kube-rbac-proxy:v0.22.0`.
    - DS PVCs request `storageClassName: fast`. Minikube only ships
      `standard`. up.sh creates a `fast` alias.

---

## Realm bootstrap gap (the four-headed `/alpha` problem)

Burned during the `update-tree` sanity-walk against `MyLogin`. The
`mcp__forgerock__create_realm` action provisions only the identity store; it
skips the rest of what ForgeOps' amster bootstrap does for `/root`. Result:
any tree in `/alpha` that touches IDM, and the whole end-user UI flow,
breaks until four separate things are patched. All four are persisted in
the memory store (`memory/project_*.md`):

1. **IDM-aware tree nodes fail in any realm.** AM's
   `IdmProvisioningClientRetrieverImpl` is realm-pinned to `/root`, then
   materializes the `idm-provisioning` OAuth2 client as an `AMIdentity` via
   the realm's identity store. `/root` has zero identity stores in this
   overlay → `IdmProvisioningClientNotFoundException` → tree throws
   `ForbiddenException` → 401. Affects `PatchObjectNode`,
   `AttributePresentDecisionNode`, `AttributeCollectorNode`,
   `IdentifyExistingUserNode`, `IncrementLoginCountNode`, `CreateObjectNode`,
   `KbaCreateNode`, `KbaVerifyNode`. **Even the seed `Login` tree** fails for
   realm users (it calls `IncrementLoginCountNode`).

2. **`/alpha` is missing the OAuth2 Provider service** (`oauth-oidc`). Until
   it's cloned in, `/am/oauth2/realms/alpha/authorize` is a 404. Cloning the
   `/root` service body via PUT works (verified live).

3. **`/alpha` is missing the standard OAuth2 clients** — `end-user-ui`,
   `admin-ui`, `idm-resource-server`, `idm-provisioning`, `idm-admin-ui`.
   They live in `/root` only. Cloning each into `/alpha` is one PUT per
   client. **API quirk caught here**: OAuth2Client config bodies want flat
   values (`"clientType": "Confidential"`), not the `{value: ...}`-wrapped
   shape some other AM endpoints use — the wrapped form returns 500 with a
   `JsonValueException`.

4. **IDM doesn't trust tokens from `/alpha`.** IDM's
   `/opt/openidm/conf/authentication.json` has exactly one `rsFilter.subjectMapping`
   entry, not realm-aware. AM introspection returns `active: true, realm:
   /alpha`, but IDM can't load `managed/user/<sub>` for users that don't
   sit in the DS suffix IDM indexes → 503 on every `/openidm/*` call.
   **Fix is a second subjectMapping entry keyed on `realm: /alpha`**, NOT a
   separate `managed/alpha_user` managed type (that's an AIC convention, not
   an IDM requirement). The IDM conf mount is an `emptyDir` populated by an
   init container, so live edits are wiped on restart — the durable fix
   belongs in the FBC source.

**What to build** when this becomes a priority: a `ops/scripts/bootstrap-realm.sh`
(or a `mcp__forgerock__bootstrap_realm` MCP action) that, given a target
realm name, performs (1)–(4) idempotently. Closes all four memories.
**Current `MyLogin` state**: stripped to the non-IDM working shape (Login
Form → Verify creds → Stub OTP → Verify OTP, with `RetryLimit` gating OTP
attempts). The IDM-aware nodes were removed from the tree's map but their
records are intact in AM, so restoring lazy email enrollment after the
bootstrap lands is a single `edit_journey_edges` call.

**Two AM 8 scripting gotchas** discovered alongside, both folded back into
the references:
- Script `context` is now `AUTHENTICATION_TREE_DECISION_NODE` (was
  `SCRIPTED_DECISION_NODE` in 7.x). Recipe 7 updated.
- The script sandbox blocks `java.lang.System.*` access — use `Date.now()`
  for timestamps. Recipe 7 and the email-OTP idiom in outcomes.md updated.

---

## Open architectural questions / not-yet-built

1. **OAuth2 service-account auth for the agent ↔ server gate** —
   `OAuthAmAuthenticator` is stubbed in `auth.ts`. Decision was made:
   coarse `forgerock.read` / `forgerock.write` scopes. To finish:
   - Wire `POST {amBaseUrl}/oauth2/introspect` for the bearer.
   - Cache introspection result ~30s keyed by token.
   - Add a script in ops/ to provision the MCP server's own AM OAuth2 client
     (so it can introspect with basic-auth as itself).

2. **Privilege separation for `mcp-admin`** — currently the MCP server uses
   `amadmin` because AM 8's delegation/privilege model isn't surfaced via
   REST in the default ForgeOps overlay. `mcp-admin` exists in the realm
   but has no special privileges. Punted; would need either AM console UI
   delegation config or a custom kustomize overlay adding the user to a
   specific DS group AM recognizes as `ui-realm-admin`.

3. **IDM tools** — confirmed needed. AM `/users` is locked down (PUT
   requires password rotation, PATCH blocks most attrs). Real journey work
   that creates/modifies users must go via IDM. Tools TBD:
   `idm_get_user`, `idm_create_user`, `idm_update_user` (no rotation),
   `idm_query`. Probably analogous to the AM tools but pointed at
   `/openidm/managed/user`.

4. **Skills not yet started**: `simplify-tree`, `test-journey`.
   - `simplify-tree`: read existing → identify reducible patterns → apply.
     Hardest of the three.
   - `test-journey`: drive a journey via the public `/json/authenticate` API,
     answering callbacks from a scenario JSON. Highest value.

5. **No test suite.** Live verification via probe scripts (`/tmp/mcp-probe.mjs`
   pattern) only. Adequate for now; would want real tests before claiming
   production readiness.

6. **RAG / better retrieval**: discussed and deferred. Current state is
   "the LLM uses jq to query references." That's the cheapest win. If the
   LLM gets clumsy with jq or we add the ForgeRock docs corpus
   (forum/runbooks/scripts), promote to a `search_node_types` MCP tool
   then a vector-DB-backed `lookup_am_docs`.

---

## Files the next agent should read first

1. `CLAUDE.md` — current commands, architecture, gotchas. Always canonical.
2. `docs/local-stack-setup.md` — authoritative stack walkthrough.
3. `agent/skills/_references/am-node-outcomes.md` — the AM vocabulary, plus
   "Querying the references" section for how to consult the catalog.
4. `mcp-server/src/index.ts` — every tool's registration with permission tag.
5. `mcp-server/src/auth.ts` — auth gate design, the static / oauth-am / disabled
   modes.
6. `mcp-server/src/am/client.ts` — `realmPath()`, the session-token retry,
   the cross-realm helpers.
7. `agent/env/.env` — the agent's copy of the shared secret. (DO NOT commit.)
8. `mcp-server/env/.env` — the server's copy. (DO NOT commit.)

After that, you're caught up.

---

## Lifecycle reminders

- All `make` targets run from **`ops/`**, not from the repo root.
- The MCP server requires `cd mcp-server && npm run build` after any TS
  changes. The host runs `dist/index.js`, not `src/index.ts`.
- After `make up` on a fresh machine: `make bootstrap` (writes
  AM_ADMIN_PASSWORD into mcp-server/env/.env) then `make token` (generates
  the shared MCP secret into both halves).
- `cd ops && make node-catalog` regenerates `agent/skills/_references/am-node-catalog.json`
  from the live AM. Run after every forgeops upgrade to catch new node
  types or schema changes.
- Reload the VS Code window after editing `~/.claude.json`. New tools
  appear without a restart.
