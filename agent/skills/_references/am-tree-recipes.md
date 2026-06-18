# AM Tree Recipes

Worked examples for building each common journey idiom from scratch via the
`mcp__forgerock__*` tools. Each recipe shows: the user-facing intent, the
nodes to create (with their config), and the `create_journey` call that wires
them.

Use these when `create-tree` matches a user's request to one of the idioms in
[am-node-outcomes.md](am-node-outcomes.md). Build *fresh* — generate new node
UUIDs each time. Do not copy the realm's seed nodes.

## Conventions used in every recipe

- **UUIDs**: throughout these recipes I write placeholder ids like `<U_username>`,
  `<U_pwdform>`. Generate real UUIDs (`crypto.randomUUID()` or any v4 generator)
  before calling MCP. Each placeholder represents one fresh UUID.
- **Order**: always `upsert_node` every node first, *then* `create_journey`.
  AM rejects a `create_journey` whose `nodes` map references a node id that
  doesn't already exist as a separate `/nodes/{type}/{id}` record.
- **Terminals**: `<SUCCESS>` = `70e691a5-1e33-4ac3-a356-e7b6d60d92e0`,
  `<FAILURE>` = `e301438c-0bd0-429c-ab0c-66126501069a`. Or call
  `mcp__forgerock__get_journey_terminals` once per session.
- **`_authToken`**: every MCP call needs it. Omitted from these recipes for
  readability; the skill's process step covers it.
- **PageNodes own their child collectors as separate node records.** A
  PageNode's `config.nodes` is `[{_id, displayName, nodeType}, ...]` —
  references to nodes you upserted independently. Don't try to inline the
  child config in the PageNode body; AM rejects it.

---

## Recipe 1: Username + password login

**User intent**: "make a login tree" / "username/password against the realm store"

**Nodes** (4 records to upsert; `<U_username>` etc. are fresh UUIDs):

| Order | Tool        | Type                      | id           | config |
|-------|-------------|---------------------------|--------------|--------|
| 1     | upsert_node | `ValidatedUsernameNode`   | `<U_username>` | `{}` (defaults are fine) |
| 2     | upsert_node | `ValidatedPasswordNode`   | `<U_password>` | `{}` |
| 3     | upsert_node | `PageNode`                | `<U_pageform>` | `{nodes: [{_id: "<U_username>", displayName: "Username", nodeType: "ValidatedUsernameNode"}, {_id: "<U_password>", displayName: "Password", nodeType: "ValidatedPasswordNode"}]}` |
| 4     | upsert_node | `DataStoreDecisionNode`   | `<U_dsdec>`    | `{}` |

**Tree**:
```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",                       // e.g. "MyLogin"
  description: "Username + password login",
  enabled: true,
  entryNodeId: "<U_pageform>",
  nodes: {
    "<U_pageform>": {
      displayName: "Login Form",
      nodeType: "PageNode",
      x: 100, y: 100,
      connections: { outcome: "<U_dsdec>" },
    },
    "<U_dsdec>": {
      displayName: "Verify credentials",
      nodeType: "DataStoreDecisionNode",
      x: 350, y: 100,
      connections: {
        true:  "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",  // SUCCESS
        false: "e301438c-0bd0-429c-ab0c-66126501069a",  // FAILURE
      },
    },
  },
})
```

**Variants**:
- Add login-counter increment: insert `IncrementLoginCountNode` between
  `<U_dsdec>` `true` outcome and `SUCCESS`.
- Add rate limiting (recommended — see red flag #8 in outcomes.md): wrap
  `<U_dsdec>` with `RetryLimitDecisionNode` so repeated failures route to
  `FAILURE` early. See Recipe 1b.

### Recipe 1b: Login + retry limit (production-shaped)

Adds rate limiting that the seed Login tree lacks.

| Order | Tool        | Type                       | id              | config |
|-------|-------------|----------------------------|-----------------|--------|
| 1     | upsert_node | `ValidatedUsernameNode`    | `<U_username>`  | `{}` |
| 2     | upsert_node | `ValidatedPasswordNode`    | `<U_password>`  | `{}` |
| 3     | upsert_node | `PageNode`                 | `<U_pageform>`  | `{nodes: [{_id:"<U_username>",displayName:"Username",nodeType:"ValidatedUsernameNode"}, {_id:"<U_password>",displayName:"Password",nodeType:"ValidatedPasswordNode"}]}` |
| 4     | upsert_node | `DataStoreDecisionNode`    | `<U_dsdec>`     | `{}` |
| 5     | upsert_node | `RetryLimitDecisionNode`   | `<U_retry>`     | `{retryLimit: 3, incrementUserAttributeOnFailure: false}` (both required; live-verified against alpha) |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Login with 3-attempt retry limit",
  enabled: true,
  entryNodeId: "<U_pageform>",
  nodes: {
    "<U_pageform>": { displayName: "Login Form", nodeType: "PageNode", x:100,y:100, connections: { outcome: "<U_dsdec>" }},
    "<U_dsdec>":    { displayName: "Verify",     nodeType: "DataStoreDecisionNode", x:350,y:100, connections: {
                       true:  "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",
                       false: "<U_retry>",
                     }},
    "<U_retry>":    { displayName: "Retry?",     nodeType: "RetryLimitDecisionNode", x:600,y:100, connections: {
                       Retry:  "<U_pageform>",                         // under limit → loop back
                       Reject: "e301438c-0bd0-429c-ab0c-66126501069a", // exhausted → FAILURE
                     }},
  },
})
```

> Note the outcome names: `RetryLimitDecisionNode` uses `Retry` and `Reject`,
> not `true`/`false` like most decision nodes. (Caught while sanity-checking
> create-tree against the live alpha realm.)

---

## Recipe 2: Self-service registration

**User intent**: "registration form that creates a managed/user record"

| Order | Tool        | Type                    | id                 | config |
|-------|-------------|-------------------------|--------------------|--------|
| 1     | upsert_node | `AttributeCollectorNode`| `<U_attrs>`        | `{attributesToCollect: ["mail","givenName","sn"], required: true, validateInputs: true, identityAttribute: "mail"}` |
| 2     | upsert_node | `ValidatedPasswordNode` | `<U_password>`     | `{}` |
| 3     | upsert_node | `PageNode`              | `<U_pageform>`     | `{nodes: [{_id:"<U_attrs>",displayName:"Attributes",nodeType:"AttributeCollectorNode"}, {_id:"<U_password>",displayName:"Password",nodeType:"ValidatedPasswordNode"}]}` |
| 4     | upsert_node | `CreateObjectNode`      | `<U_create>`       | `{identityResource: "managed/user"}` |
| 5     | upsert_node | `IncrementLoginCountNode`| `<U_inc>`         | `{}` |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Self-service registration",
  enabled: true,
  entryNodeId: "<U_pageform>",
  nodes: {
    "<U_pageform>": { displayName: "Registration Form", nodeType: "PageNode", x:100,y:100, connections: { outcome: "<U_create>" }},
    "<U_create>":   { displayName: "Create User",        nodeType: "CreateObjectNode", x:350,y:100, connections: {
                       CREATED: "<U_inc>",
                       FAILURE: "e301438c-0bd0-429c-ab0c-66126501069a",
                     }},
    "<U_inc>":      { displayName: "Login count",        nodeType: "IncrementLoginCountNode", x:600,y:100, connections: {
                       outcome: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",
                     }},
  },
})
```

> AttributeCollectorNode's exact required fields vary across forgeops versions
> — always check `get_node_type_schema` before relying on the config above.
> The seed `Registration` tree's PageNode is a good reference for what to
> collect.

---

## Recipe 3: Forgot password (suspend-and-resume via email link)

**User intent**: "forgot-password flow with email link"

| Order | Tool        | Type                       | id              | config |
|-------|-------------|----------------------------|-----------------|--------|
| 1     | upsert_node | `AttributeCollectorNode`   | `<U_email>`     | `{attributesToCollect: ["mail"], identityAttribute: "mail", required: true, validateInputs: true}` |
| 2     | upsert_node | `PageNode`                 | `<U_pgask>`     | `{nodes: [{_id:"<U_email>",displayName:"Email",nodeType:"AttributeCollectorNode"}]}` |
| 3     | upsert_node | `IdentifyExistingUserNode` | `<U_findUser>`  | `{identityAttribute: "mail", identifier: "mail"}` |
| 4     | upsert_node | `EmailSuspendNode`         | `<U_suspend>`   | `{emailTemplateName: "resetPassword", emailAttribute: "mail", identityAttribute: "mail", emailSuspendMessage: {"en": "Check your email for a reset link"}, objectLookup: true}` |
| 5     | upsert_node | `ValidatedPasswordNode`    | `<U_newpw>`     | `{}` |
| 6     | upsert_node | `PageNode`                 | `<U_pgnew>`     | `{nodes: [{_id:"<U_newpw>",displayName:"New password",nodeType:"ValidatedPasswordNode"}]}` |
| 7     | upsert_node | `PatchObjectNode`          | `<U_patch>`     | `{identityResource: "managed/user", identityAttribute: "mail", patchAsObject: true, ignoredFields: []}` |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Forgot password",
  enabled: true,
  entryNodeId: "<U_pgask>",
  nodes: {
    "<U_pgask>":    { displayName: "Ask email",     nodeType: "PageNode",                  x:100,y:100, connections: { outcome: "<U_findUser>" }},
    "<U_findUser>": { displayName: "Find user",     nodeType: "IdentifyExistingUserNode",  x:350,y:100, connections: {
                       true:  "<U_suspend>",
                       false: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",   // SILENT SUCCESS — don't leak existence
                     }},
    "<U_suspend>":  { displayName: "Send link",     nodeType: "EmailSuspendNode",          x:600,y:100, connections: { outcome: "<U_pgnew>" }},
    "<U_pgnew>":    { displayName: "New password",  nodeType: "PageNode",                  x:850,y:100, connections: { outcome: "<U_patch>" }},
    "<U_patch>":    { displayName: "Save password", nodeType: "PatchObjectNode",           x:1100,y:100, connections: {
                       PATCHED: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",
                       FAILURE: "e301438c-0bd0-429c-ab0c-66126501069a",
                     }},
  },
})
```

**Important**: `IdentifyExistingUserNode`'s `false` branch routes to **SUCCESS**,
not FAILURE. This is intentional — leaking whether an email exists in the
directory is an enumeration vulnerability. The user gets the same UX whether
the email is registered or not.

---

## Recipe 4: Forgot username

**User intent**: "email me my username"

Same shape as Recipe 3 but instead of `PatchObjectNode` you use an
`InnerTreeEvaluatorNode` that runs a `DisplayUserNameNode` after the email
resume. Or simpler: the `EmailSuspendNode` template includes the username, and
the resume just goes to SUCCESS.

| Order | Tool        | Type                       | id              | config |
|-------|-------------|----------------------------|-----------------|--------|
| 1     | upsert_node | `AttributeCollectorNode`   | `<U_email>`     | `{attributesToCollect: ["mail"], identityAttribute: "mail", required: true, validateInputs: true}` |
| 2     | upsert_node | `PageNode`                 | `<U_pgask>`     | `{nodes: [{_id:"<U_email>",displayName:"Email",nodeType:"AttributeCollectorNode"}]}` |
| 3     | upsert_node | `IdentifyExistingUserNode` | `<U_findUser>`  | `{identityAttribute: "mail", identifier: "mail"}` |
| 4     | upsert_node | `EmailSuspendNode`         | `<U_suspend>`   | `{emailTemplateName: "forgottenUsername", emailAttribute: "mail", identityAttribute: "mail", emailSuspendMessage: {"en": "Check your email for your username"}, objectLookup: true}` |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Forgot username",
  enabled: true,
  entryNodeId: "<U_pgask>",
  nodes: {
    "<U_pgask>":    { displayName: "Ask email",  nodeType: "PageNode",                 x:100,y:100, connections: { outcome: "<U_findUser>" }},
    "<U_findUser>": { displayName: "Find user",  nodeType: "IdentifyExistingUserNode", x:350,y:100, connections: {
                       true:  "<U_suspend>",
                       false: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",   // silent success
                     }},
    "<U_suspend>":  { displayName: "Send email", nodeType: "EmailSuspendNode",         x:600,y:100, connections: {
                       outcome: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",
                     }},
  },
})
```

> The seed `ForgottenUsername` tree adds an `InnerTreeEvaluatorNode` after the
> resume. Inspect it with `explain-tree` for a more elaborate variant.

---

## Recipe 5: Progressive profile prompt (Nth login)

**User intent**: "ask the user to fill missing profile fields on their 5th login"

This tree is designed to be invoked as a sub-tree from a primary login tree's
`InnerTreeEvaluatorNode`. The seed Login tree composes this exact tree.

| Order | Tool        | Type                       | id              | config |
|-------|-------------|----------------------------|-----------------|--------|
| 1     | upsert_node | `LoginCountDecisionNode`   | `<U_count>`     | `{interval: 5, amount: 0}` (every 5th login; check schema) |
| 2     | upsert_node | `QueryFilterDecisionNode`  | `<U_qfilter>`   | `{queryFilter: "/preferences pr"}` (check schema) |
| 3     | upsert_node | `AttributeCollectorNode`   | `<U_attrs>`     | `{attributesToCollect: ["preferences/marketing","preferences/updates"], required: false, validateInputs: false}` |
| 4     | upsert_node | `PageNode`                 | `<U_pgask>`     | `{nodes: [{_id:"<U_attrs>",displayName:"Preferences",nodeType:"AttributeCollectorNode"}]}` |
| 5     | upsert_node | `PatchObjectNode`          | `<U_patch>`     | `{identityResource: "managed/user", identityAttribute: "userName", patchAsObject: true, ignoredFields: []}` |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Progressive profile every 5th login",
  enabled: true,
  entryNodeId: "<U_count>",
  nodes: {
    "<U_count>":   { displayName: "Nth login?",     nodeType: "LoginCountDecisionNode",  x:100,y:100, connections: {
                      true:  "<U_qfilter>",
                      false: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",     // not an Nth login → done
                    }},
    "<U_qfilter>": { displayName: "Already set?",   nodeType: "QueryFilterDecisionNode", x:350,y:100, connections: {
                      true:  "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",     // already populated
                      false: "<U_pgask>",
                    }},
    "<U_pgask>":   { displayName: "Ask preferences", nodeType: "PageNode",                x:600,y:100, connections: { outcome: "<U_patch>" }},
    "<U_patch>":   { displayName: "Save",            nodeType: "PatchObjectNode",         x:850,y:100, connections: {
                      PATCHED: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",
                      FAILURE: "e301438c-0bd0-429c-ab0c-66126501069a",
                    }},
  },
})
```

> Most progressive-profile trees are *not* the entry tree the user hits
> directly — they're invoked by the primary login tree via
> `InnerTreeEvaluatorNode`. To wire this up: edit the primary login to insert
> an `InnerTreeEvaluatorNode` with `tree: "<your TreeId>"` between
> DataStoreDecision's `true` and SUCCESS.

---

## Recipe 6: Update password (with active session + email fallback)

**User intent**: "change password while logged in, fall back to email link if they forgot the current one"

| Order | Tool        | Type                          | id              | config |
|-------|-------------|-------------------------------|-----------------|--------|
| 1     | upsert_node | `SessionDataNode`             | `<U_sess>`      | `{sessionDataKey: "UserToken", sharedStateKey: "username"}` |
| 2     | upsert_node | `ValidatedPasswordNode`       | `<U_curpw>`     | `{}` |
| 3     | upsert_node | `ValidatedPasswordNode`       | `<U_newpw>`     | `{}` |
| 4     | upsert_node | `PageNode`                    | `<U_pgform>`    | `{nodes: [{_id:"<U_curpw>",displayName:"Current",nodeType:"ValidatedPasswordNode"}, {_id:"<U_newpw>",displayName:"New",nodeType:"ValidatedPasswordNode"}]}` |
| 5     | upsert_node | `DataStoreDecisionNode`       | `<U_verifyCur>` | `{}` |
| 6     | upsert_node | `PatchObjectNode`             | `<U_patch>`     | `{identityResource: "managed/user", identityAttribute: "userName", patchAsObject: true}` |
| 7     | upsert_node | `AttributePresentDecisionNode`| `<U_hasEmail>`  | `{presentAttribute: "mail"}` |
| 8     | upsert_node | `EmailSuspendNode`            | `<U_suspend>`   | `{emailTemplateName: "updatePassword", emailAttribute: "mail", identityAttribute: "userName", emailSuspendMessage: {"en":"Check your email for a reset link"}, objectLookup: true}` |
| 9     | upsert_node | `PageNode`                    | `<U_pgnew2>`    | `{nodes: [{_id:"<U_newpw>",displayName:"New",nodeType:"ValidatedPasswordNode"}]}` (reuses `<U_newpw>` — fine, child nodes can be referenced by multiple PageNodes) |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Update password with email fallback",
  enabled: true,
  entryNodeId: "<U_sess>",
  nodes: {
    "<U_sess>":      { displayName: "Get session user", nodeType: "SessionDataNode",            x:50,y:100, connections: { outcome: "<U_pgform>" }},
    "<U_pgform>":    { displayName: "Cur+new pw form",  nodeType: "PageNode",                   x:300,y:100, connections: { outcome: "<U_verifyCur>" }},
    "<U_verifyCur>": { displayName: "Verify current",   nodeType: "DataStoreDecisionNode",       x:550,y:100, connections: {
                        true:  "<U_patch>",
                        false: "<U_hasEmail>",
                      }},
    "<U_patch>":     { displayName: "Save new pw",      nodeType: "PatchObjectNode",            x:800,y:100, connections: {
                        PATCHED: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",
                        FAILURE: "e301438c-0bd0-429c-ab0c-66126501069a",
                      }},
    "<U_hasEmail>":  { displayName: "Has email?",       nodeType: "AttributePresentDecisionNode", x:550,y:300, connections: {
                        true:  "<U_suspend>",
                        false: "e301438c-0bd0-429c-ab0c-66126501069a",
                      }},
    "<U_suspend>":   { displayName: "Email link",       nodeType: "EmailSuspendNode",           x:800,y:300, connections: { outcome: "<U_pgnew2>" }},
    "<U_pgnew2>":    { displayName: "New password",     nodeType: "PageNode",                   x:1050,y:300, connections: { outcome: "<U_patch>" }},
  },
})
```

Note `<U_patch>` is reached from two paths (the verified-current path and the
email-recovery path). That's fine — a node can have multiple inbound edges.
What it *cannot* have is two different outbound configs for the same outcome.

---

## Recipe 7: ScriptedDecisionNode (custom branching logic)

**User intent**: "branch on something AM's stock decision nodes can't express" —
custom risk scoring, tier-based routing, header inspection, etc.

This is the only recipe that requires `upsert_script` *before* `upsert_node`.

### Mental model

Three things, decoupled:

1. **The script** (`/scripts/{id}`) — the JavaScript/Groovy source. Has a
   `context` (must be `SCRIPTED_DECISION_NODE` for SDN use). Doesn't know what
   outcomes the SDN will declare; it just sets the `outcome` variable.
2. **The ScriptedDecisionNode** (`/nodes/ScriptedDecisionNode/{id}`) — declares
   `config.outcomes` (the array of outcome names the LLM uses to wire the
   tree's `connections`), points to a script id via `config.script`, declares
   `inputs` and `outputs` (which sharedState keys it reads/writes — `["*"]` is
   "any").
3. **The tree** — wires the SDN's outcome names in `connections`.

Same script can back multiple SDNs with different outcome arrays (the script
must set an outcome name that matches whichever SDN currently invokes it).

### Build order (4 steps)

| Order | Tool          | Type                  | id              | config / source |
|-------|---------------|-----------------------|-----------------|-----------------|
| 1     | upsert_script | (n/a)                 | `<S_tier>`      | `name="tier-score"`, `language="JAVASCRIPT"`, `context="AUTHENTICATION_TREE_DECISION_NODE"` (AM 8.x; was `SCRIPTED_DECISION_NODE` in 7.x), `source="outcome = sharedState.get('userTier') === 'gold' ? 'gold' : 'silver';"` |
| 2     | upsert_node   | `ScriptedDecisionNode`| `<U_sdn>`       | `{script: "<S_tier>", outcomes: ["gold","silver"], inputs: ["*"], outputs: ["*"]}` |

```js
create_journey({
  realm: "<realm>",
  id: "<TreeId>",
  description: "Tier-based routing",
  enabled: true,
  entryNodeId: "<U_sdn>",
  nodes: {
    "<U_sdn>": {
      displayName: "Tier check",
      nodeType: "ScriptedDecisionNode",
      x: 100, y: 100,
      connections: {
        gold:   "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",   // SUCCESS for gold
        silver: "70e691a5-1e33-4ac3-a356-e7b6d60d92e0",   // SUCCESS for silver too in this minimal example
      },
    },
  },
})
```

### Things to know

- **The script source must NOT be base64-encoded by the caller.**
  `upsert_script` accepts plain text and encodes for you.
- **Script `context` value**: use `SCRIPTED_DECISION_NODE` (canonical on
  ForgeOps 2025.2 / AM 8.1, live-verified). `AUTHENTICATION_TREE_DECISION_NODE`
  is an older alias that still resolves, but `list_script_contexts` explicitly
  says "prefer SCRIPTED_DECISION_NODE". If `upsert_script` returns "context not
  found / invalid", list valid contexts with
  `mcp__forgerock__list_script_contexts`.
- **`config.outcomes` is the source of truth for outcome names.** If the
  script sets `outcome = "premium"` but the SDN's outcomes are `["gold","silver"]`,
  AM raises a runtime error when that branch is taken.
- **`inputs`/`outputs`** are sharedState key names the script reads/writes.
  `["*"]` = any. Be specific in production for performance + safety.
- **Available variables in the script depend on the evaluator version.**
  ⚠ ForgeOps 2025.2 / AM 8.1 scripts created via `upsert_script` default to
  the **next-gen evaluator (`evaluatorVersion: "2.0"`)**, whose API is NOT the
  legacy one most docs/examples show. See the next subsection — getting this
  wrong is the #1 way these scripts fail at runtime (and `explain-tree` can't
  catch it; it only checks wiring). Confirm a script's version with
  `mcp__forgerock__get_script` (`evaluatorVersion` field); the global default
  script "Next Generation Scripted Decision Node Script" is 2.0 and a good
  reference (`action.goTo("true")`).
- **AM 8 script sandbox blocks `java.lang.*` direct access.** Calling
  `java.lang.System.currentTimeMillis()` throws `TypeError: Cannot call
  property currentTimeMillis in object [JavaPackage java.lang.System]`. For
  timestamps use `Date.now()` (JS-native, returns ms since epoch — accepted
  as Long where AM expects one). For most other Java interop, prefer the
  bound bindings (`idRepository`, `httpClient`, `secrets`) over direct class
  access. Live-burned during MyLogin sanity-walk.
- **Cleanup ordering**: delete the SDN before the script, or AM will refuse
  to delete a script that's still referenced.

### ⚠ Next-gen evaluator (2.0) script API — read before writing any SDN script

On this stack (ForgeOps 2025.2 / AM 8.1) `upsert_script` creates scripts at
`evaluatorVersion "2.0"` (next-gen). **The legacy 1.0 bindings do not exist in
2.0** — `outcome = "x"`, `sharedState`, and `transientState` throw
`ReferenceError` / silently no-op. A script written the legacy way *saves
fine, wires fine, and explain-tree shows no red flag* — it only blows up when
AM executes the node (HTTP 401 "Login failure"). All of the below was
live-burned building the `MfaLogin` tree on 2026-06-10.

| Need | Legacy 1.0 (DON'T use here) | Next-gen 2.0 (correct) |
|------|----------------------------|------------------------|
| Set the outcome | `outcome = "set"` | `action.goTo("set")` |
| Read shared state | `sharedState.get("k")` | `nodeState.get("k")` |
| Write shared state | `sharedState.put("k",v)` | `nodeState.putShared("k",v)` |
| Write transient state | `transientState.put("k",v)` | `nodeState.putTransient("k",v)` |
| Prompt / send a callback | `action = Action.send(cb).build()` | `callbacksBuilder.nameCallback("prompt")` — see below |
| Read a submitted callback | `callbacks.get(0).getName()` | `callbacks.getNameCallbacks().get(0)` — see below |

Key 2.0 specifics:

- **`nodeState.get("username")` returns a plain `String`** — do NOT call
  `.asString()` on it (`TypeError: Cannot find function asString`). Wrap with
  `String(...)` if you want a JS string. `nodeState.keys()` lists what's
  present (after a plain username/password login: `realm, authLevel,
  objectAttributes, username` — there is no `universalId`, and
  `objectAttributes.get("mail")` is null).
- **Sending callbacks**: `action` is an `ActionWrapper` that only exposes
  `goTo` (+ session/error helpers) to scripts — it has **no `send` and no
  `setCallbacks`** (both throw "Cannot find function"). Instead call the
  `callbacksBuilder` binding, e.g. `callbacksBuilder.nameCallback("Hi, your
  email?")`. These methods return **void** and *accumulate* callbacks; the
  engine sends them automatically **only when the script ends without setting
  an outcome** (don't call `action.goTo` on the prompt pass). Builder also has
  `passwordCallback(prompt,echoOn)`, `choiceCallback`, `confirmationCallback`,
  `textInputCallback`, `hiddenValueCallback`, `stringAttributeInputCallback`, …
- **Reading callbacks**: `callbacks` is a `ScriptedCallbacksWrapper` with
  `isEmpty()` and **typed getters** — there is **no `callbacks.get(i)`**. Use
  `callbacks.getNameCallbacks()` → `List<String>` of entered values,
  `getPasswordCallbacks()`, `getChoiceCallbacks()` → `List<int[]>`, etc.
- **Reading a user profile attribute**: `var id =
  idRepository.getIdentity(name); id.exists(); id.getAttributeValues("mail")` →
  `List<String>`. ⚠ On this platform's store, AM identities are named by
  **`fr-idm-uuid`**, so `getIdentity("<uid>")` (e.g. `"alice"`) returns a
  not-found wrapper — `.exists()` is false and `getAttributeValues` then NPEs
  on a null `amIdentity`. You must pass the user's **uuid**. There is no
  uid→uuid search in the scripting API itself. (DataStoreDecision still
  authenticates by uid fine — only the scripting `idRepository` lookup needs
  the uuid.)
  - **Get the uuid generically — don't hardcode it.** Put an
    **`IdentifyExistingUserNode`** in the tree *before* the SDN, configured
    `{identityAttribute:"userName", identifier:"userName"}`. It searches IDM
    using `objectAttributes.userName` (DataStoreDecision already sets that),
    and on its `true` outcome writes the resolved **uuid into `nodeState` as
    `_id`**. The SDN then reads
    `idRepository.getIdentity(String(nodeState.get("_id")))`. Works for any
    user, no hardcoded uuid — live-verified in MfaLogin 2026-06-10. Wire
    `Identify User` `true → <SDN>`, `false → FAILURE`. (The stock query nodes
    `IdentifyExistingUserNode` / `QueryFilterDecisionNode` resolve users by
    uid/userName against IDM, but they're *decision* nodes — they don't hand a
    script arbitrary attributes, and `QueryFilterDecisionNode`'s filter is
    static config, so it can't compare against live user input. Pairing
    Identify-User with an SDN is the working combo.)
- **Sandbox**: reflection is blocked (`obj.getClass()` → TypeError), and
  `java.lang.System.currentTimeMillis()` is blocked — use `Date.now()`.
- **⚠ Collection iteration is sandbox-blocked — index, don't iterate.** On a
  `List` returned by a binding (e.g. `id.getAttributeValues("mail")`),
  `.iterator()` / `.iterator().next()` throws `ScriptException: Access to Java
  class "java.util.ArrayList$Itr" is prohibited` *at runtime* (saves and wires
  fine; explain-tree can't catch it). Read by index instead: guard with
  `.size() > 0` (or `!list.isEmpty()`) then take `list.get(0)`. Same applies to
  any `for...of` / spread that would call `.iterator()` under the hood.
  Live-burned 2026-06-10 building `TestMFA`'s Alice-email gate.
- **Debugging**: `logger.error("MARKER " + value)` from a script **does reach
  the AM pod stdout** (`kubectl logs -n identity <am-pod>` — grep your marker).
  This is the fastest way to inspect bindings live. When a binding's real
  method names are unknown, decompile from the AM jar:
  `kubectl exec <am-pod> -c openam -- bash -lc 'cd /tmp; jar xf
  /usr/local/tomcat/webapps/am/WEB-INF/lib/auth-nodes-8.1.0.jar <ClassPath>.class;
  javap -public <ClassPath>.class'` — `ActionWrapper`,
  `ScriptedCallbacksBuilder`, `ScriptedCallbacksWrapper` are in
  `auth-nodes-8.1.0.jar`; `ScriptedIdentity*` in `openam-core-8.1.0.jar`.

Minimal 2.0 prompt-and-verify skeleton (collect free text, compare to profile):

```js
// Prereq: an IdentifyExistingUserNode (identityAttribute:"userName") sits before
// this SDN and has put the resolved uuid into nodeState as "_id".
var username = String(nodeState.get("username"));
if (username !== "alice") {
  action.goTo("proceed");                 // no prompt for everyone else
} else if (callbacks.isEmpty()) {
  callbacksBuilder.nameCallback("Hi Alice, What is your email?");  // sends on script end
} else {
  var entered = String(callbacks.getNameCallbacks().get(0));
  var id = idRepository.getIdentity(String(nodeState.get("_id")));  // uuid, NOT "alice"
  var actual = (id && id.exists() && !id.getAttributeValues("mail").isEmpty())
    ? String(id.getAttributeValues("mail").get(0)) : "";
  action.goTo(actual !== "" && entered.trim().toLowerCase() === actual.trim().toLowerCase()
    ? "proceed" : "incorrect");
}
```

Re-stub of the Email/SMS-OTP dev idiom (the one in `am-node-outcomes.md`) for
2.0 — the legacy `transientState.put` version silently breaks here:

```js
nodeState.putTransient("oneTimePassword", "000000");
nodeState.putTransient("oneTimePasswordTimestamp", Date.now());
action.goTo("set");
```

### Variant: combining with a stock decision node

Common pattern — use SDN to compute a value, then route on that value with
a stock node like `AttributeValueDecisionNode`. Lets the script focus on the
computation (one place to update) while the routing is declarative.

## After every recipe: verify

Run `explain-tree` on the new tree and read the output back to the user.
Confirm:

- The path narratives match what the user asked for.
- Red flags are empty (or, if any, are deliberate — call them out).

If the explanation reveals a wiring mistake, fix with `edit_journey_edges` (no
need to delete + recreate).

---

## What to do when no recipe matches

The user's intent doesn't fit any of the above. Then:

1. Decompose the requirement into per-step needs (collect input → check
   condition → take action → terminate). Each step is one node.
2. For each step, find the right node type via `list_node_types` (filter by
   tags: `basic authn`, `risk`, `multi-factor`, `utilities`, `behavioral`,
   `federation`, `iot`, `progressive profile`).
3. For each chosen type, fetch its config schema with
   `get_node_type_schema`, and check `am-node-outcomes.md` (or fetch an
   existing instance) for its outcome names.
4. Sketch the wiring as a plan first. Show the user. Iterate. Then build.
