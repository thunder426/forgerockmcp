# AM Node Outcomes & Idioms

A hand-curated map of which nodes emit which outcomes in their `connections`,
plus the common multi-node patterns that show up in real journeys. Companion
to `am-node-catalog.json` (which has the *config-side* schema for the same
nodes but doesn't expose outcome names — those are not in the AM REST schema
endpoint, and for some node types are user-configured, not type-fixed).

How to read each table row:
- **Outcomes**: the keys you'll see in a node's `connections` map.
- **Notes**: anything non-obvious (default behaviors, gotchas).

If you encounter a node not listed here:
1. Check `am-node-catalog.json` for its config schema and `help` text.
   **Don't load the whole catalog** (~115K tokens) — query it. See "Querying
   the references" below.
2. If the journey already has an instance, GET it via `mcp__forgerock__get_node` —
   the response includes an `_outcomes` array with the live outcome names.
3. Update this file with what you learned.

---

## Querying the references (read this first)

The reference files are large enough that loading them whole into context is
wasteful. Use targeted shell queries via the `Bash` tool instead. The skills
point here for the recipes.

`am-node-catalog.json` is keyed by node type id under `.types.<TypeId>`.
Each entry has `name`, `tags`, `help`, `config.required`, `config.properties`.

### Recipe: keyword search across all node types
Find which node types match a concept (e.g. "captcha", "device", "kba"):
```bash
jq -r '.types | to_entries | map(select(
  (.key + " " + .value.name + " " + (.value.tags|join(" ")) + " " + .value.help)
  | ascii_downcase | contains("captcha")
)) | .[] | "\(.key) — \(.value.name): \(.value.help)"' \
  agent/skills/_references/am-node-catalog.json
```

Replace `"captcha"` with your search term (must be lowercase). Returns lines
like `product-CaptchaNode — Captcha: Verifies the user is human via …`.

### Recipe: load the schema for one specific node type
After picking a candidate from the search above:
```bash
jq '.types.RetryLimitDecisionNode' agent/skills/_references/am-node-catalog.json
```
Output is the full entry: name, tags, help, config schema (~5-50 lines per
type vs. ~115K tokens for the whole catalog).

### Recipe: list all types matching a tag
Real tag values include: `authentication`, `authz`, `basic authentication`,
`basic authn`, `behavioral`, `contextual`, `federation`, `identity assertion`,
`identity management`, `idm`, `iot`, `kerberos`, `metrics`, `mfa`,
`multi-factor authentication`, `otp`, `platform`, `risk`, `social`,
`utilities`, `windows`. Get the live list with:
```bash
jq -r '[.types[].tags[]] | unique | .[]' agent/skills/_references/am-node-catalog.json
```
Then filter:
```bash
jq -r '.types | to_entries
  | map(select(.value.tags | index("mfa")))
  | .[] | "\(.key) — \(.value.name)"' \
  agent/skills/_references/am-node-catalog.json
```

### Recipe: peek at the recipes file for a specific intent
```bash
grep -n -i -A 1 "user intent" agent/skills/_references/am-tree-recipes.md
```
Gives a one-line index of every recipe by intent. Then read just the matching
recipe section with `sed -n` or a targeted `Read` of the line range.

### When to load a whole reference file
Only when iterating on its content (writing a new recipe, hand-curating a new
outcomes row). For *using* the references during a tree walk or build, query.

---

## Type-fixed outcomes (deterministic — outcomes don't depend on config)

### Decision nodes — emit `true` / `false`
Every "is this thing true about the user/session/request?" check follows this pattern.

| Node type                       | Tested for                                                  |
|---------------------------------|-------------------------------------------------------------|
| `DataStoreDecisionNode`         | Username + password match the realm's identity store        |
| `LdapDecisionNode`              | LDAP bind success against a configured directory            |
| `AuthLevelDecisionNode`         | Current session's authentication level meets a threshold    |
| `AccountActiveDecisionNode`     | Target user account is active (not locked / disabled)       |
| `AccountLockoutNode`            | Whether the user is currently locked out                    |
| `AppPolicyDecisionNode`         | Application policy permits the request                      |
| `PolicyDecisionNode`            | Generic AM policy evaluation                                |
| `CookiePresenceDecisionNode`    | Named cookie present on the request                         |
| `PersistentCookieDecisionNode`  | AM's persistent-cookie session cookie present + valid       |
| `AttributePresentDecisionNode`  | Named user attribute present (and optionally non-empty)     |
| `AttributeValueDecisionNode`    | Named user attribute matches a comparator                   |
| `LoginCountDecisionNode`        | User's login count meets a configured condition             |
| `TimeSinceDecisionNode`         | Time since a recorded event meets a threshold               |
| `QueryFilterDecisionNode`       | A CREST `_queryFilter` returns ≥1 user                      |
| `IdentifyExistingUserNode`      | A user matching shared-state attrs exists in the data store |
| `KbaDecisionNode`               | KBA questions are configured for the user                   |
| `RequiredAttributesDecisionNode`| All required user attributes are populated                  |
| `ProfileCompletenessDecisionNode` | User profile completeness meets a threshold               |
| `TermsAndConditionsDecisionNode`  | User has accepted current T&Cs                            |
| `InnerTreeEvaluatorNode`        | Result of the inner tree (success → true, failure → false)  |
| `OneTimePasswordCollectorDecisionNode` | OTP entered correctly                                |
| `ZeroPageLoginNode`             | Username + password present in HTTP headers (SSO bridge)    |

### Pure-action nodes — single outcome `outcome`
Do something, advance regardless of result (failures throw, not branch).

| Node type                       | Action                                                      |
|---------------------------------|-------------------------------------------------------------|
| `PageNode`                      | Render its inner `nodes` (callback collectors) as one form  |
| `UsernameCollectorNode`         | Prompt for username                                         |
| `PasswordCollectorNode`         | Prompt for password                                         |
| `ValidatedUsernameNode`         | Prompt for username, server-side validation                 |
| `ValidatedPasswordNode`         | Prompt for password, server-side validation                 |
| `AttributeCollectorNode`        | Prompt for one or more profile attributes                   |
| `ChoiceCollectorNode`           | **See "Dynamic outcomes" below** — outcome names are configured |
| `MessageNode`                   | Display a message; user clicks continue                     |
| `IncrementLoginCountNode`       | Bump the user's login count                                 |
| `ConsentNode`                   | Display + record consent for declared mappings              |
| `KbaCreateNode`                 | Prompt user to set KBA questions                            |
| `KbaVerifyNode`                 | Prompt user to answer their KBA questions                   |
| `EmailSuspendNode`              | Suspend journey + send email; resume on link click          |
| `EmailTemplateNode`             | Send an email (no suspend)                                  |
| `OneTimePasswordGeneratorNode`  | Generate an OTP into **transient** state (see "Email-OTP MFA idiom" below) |
| `OneTimePasswordSmsSenderNode`  | Send transient-state OTP via SMS                            |
| `OneTimePasswordSmtpSenderNode` | Send transient-state OTP via email                          |
| `SetSessionPropertiesNode`      | Add named properties to the resulting session               |
| `RemoveSessionPropertiesNode`   | Remove named properties                                     |
| `SessionDataNode`               | Read a value from the current session into shared state     |
| `SetStateNode`                  | Write into the journey's shared state                       |
| `SetCustomCookieNode`           | Set an HTTP cookie on the response                          |
| `SetSuccessUrlNode` / `SetFailureUrlNode` | Override post-journey redirect target           |
| `SetSuccessDetailsNode` / `SetFailureDetailsNode` | Annotate success/failure response          |
| `MeterNode`                     | Increment a metrics counter                                 |
| `TimerStartNode` / `TimerStopNode` | Start/stop a journey-internal timer                      |
| `DebugNode`                     | Log shared-state for debugging                              |

### Decision nodes with custom outcome names (NOT true/false)
A few decision nodes break from the `true`/`false` convention. Always check
`am-node-catalog.json` or fetch an instance if you're unsure.

| Node type                       | Outcomes                                                |
|---------------------------------|---------------------------------------------------------|
| `RetryLimitDecisionNode`        | `Retry` (under limit, loop back) / `Reject` (exhausted) |

### IDM CRUD nodes — emit `CREATED` / `PATCHED` / `FAILURE`
Talk to IDM's managed-user (or other managed object) endpoint. Failure outcome is the *single* error branch.

| Node type             | Outcomes              | Notes                                   |
|-----------------------|-----------------------|-----------------------------------------|
| `CreateObjectNode`    | `CREATED`, `FAILURE`  | Default: creates `managed/user`         |
| `PatchObjectNode`     | `PATCHED`, `FAILURE`  | Patches the identity in shared state    |
| `DisplayUserNameNode` | `outcome`             | Pure read — single outcome              |

### Multi-factor outcome sets

| Node type                         | Outcomes                                                          |
|-----------------------------------|-------------------------------------------------------------------|
| `OathRegistrationNode`            | `successOutcome`, `failureOutcome` (displayNames "Success"/"Failure") |
| `OathTokenVerifierNode`           | `successOutcome`, `failureOutcome`, `notRegisteredOutcome`, and `recoveryCodeOutcome` **only when `isRecoveryCodeAllowed: true`** (with it `false`, the node emits just the first 3 — wiring a `recoveryCodeOutcome` edge then is a harmless phantom AM ignores at runtime). displayNames "Success"/"Failure"/"Not registered"/"Recovery Code"; connections keys are the **ids**, not the displayNames. Live-verified on AM 8.1 root realm (TestMFA, 2026-06-17). |
| `PushRegistrationNode`            | `success`, `failure`, `time out`                                  |
| `PushAuthenticationSenderNode`    | `success`, `failure`, `not registered`                            |
| `PushResultVerifierNode`          | `success`, `failure`, `expired`, `waiting`                        |
| `PushWaitNode`                    | `done`                                                            |
| `WebAuthnRegistrationNode`        | `unsupported`, `success`, `failure`, `error` (DOM/client error; displayName is "Client Error") |
| `WebAuthnAuthenticationNode`      | `unsupported`, `noDevice` (displayName "No Device Registered"), `success`, `failure`, `error` (displayName "Client Error") |
| `RecoveryCodeCollectorDecisionNode` | `success`, `failure`                                            |
| `RecoveryCodeDisplayNode`         | `outcome`                                                         |
| `OptOutMultiFactorAuthenticationNode` | `outcome`                                                     |

### Social / federated

| Node type                       | Outcomes                          |
|---------------------------------|-----------------------------------|
| `SocialProviderHandlerNode`     | `account exists`, `no account`    |
| `SocialNode`                    | `account exists`, `no account`    |
| `SelectIdPNode`                 | `socialAuthentication`, `localAuthentication` |
| `OidcNode`                      | `account exists`, `no account`    |

### Captcha / risk

| Node type                       | Outcomes                          |
|---------------------------------|-----------------------------------|
| `product-CaptchaNode`           | `success`, `failure`              |
| `product-CaptchaEnterpriseNode` | `success`, `failure`              |
| `product-ReCaptchaNode`         | `success`, `failure`              |
| `product-PingOneProtectEvaluationNode` | `LOW`, `MEDIUM`, `HIGH`, `FAILURE` |

---

## Dynamic outcomes (depend on the node's config — must inspect the instance)

For these node types, the outcome list is configured per-instance. You **cannot**
predict outcomes from the type alone. Always GET the instance via
`mcp__forgerock__get_node` and read its `_outcomes` array (or read its config
to derive what AM will emit).

| Node type                  | What determines outcomes                                      |
|----------------------------|---------------------------------------------------------------|
| `ChoiceCollectorNode`      | Each entry in the `choices` array becomes an outcome name     |
| `ScriptedDecisionNode`     | **The SDN's `config.outcomes` array** (NOT the script). Use `mcp__forgerock__get_script` to read the source; the script must set `outcome` to one of those names. |
| `ConfigProviderNode`       | The configured wrapped node's outcomes                        |
| `ConsentNode`              | Number of declared mapping consents → that many outcomes      |

`InnerTreeEvaluatorNode` is *technically* fixed at `true`/`false` (above) but
its semantics depend entirely on the inner tree it runs — explain-tree should
fetch and explain that inner tree too if it's not a well-known one.

---

## Reserved terminal UUIDs

Every tree has two AM-wide reserved terminal nodes that nodes' `connections`
point to for end-of-journey outcomes. These are constants — same in every
realm, same in every tree.

| Role     | UUID                                       |
|----------|--------------------------------------------|
| Success  | `70e691a5-1e33-4ac3-a356-e7b6d60d92e0`    |
| Failure  | `e301438c-0bd0-429c-ab0c-66126501069a`    |

Use `mcp__forgerock__get_journey_terminals` to fetch them at runtime.

The tree's `staticNodes` field shows where the AM admin UI lays them out for
the editor — but `staticNodes` is **null on REST-created trees** and is
editor-only metadata. Never rely on it to tell you what the terminals are.

---

## Common idioms (what real trees actually look like)

### Username + password login
```
PageNode (entry)                              → outcome
  ├ inner: ValidatedUsernameNode              (callback collector — no outcome on the outer graph)
  └ inner: ValidatedPasswordNode              (callback collector — no outcome on the outer graph)
DataStoreDecisionNode                         → true → SUCCESS
                                              → false → FAILURE
```
Source: `Login` tree (alpha realm). PageNodes have an *inner* `nodes` array of
callback collectors that aren't visible on the outer graph. To explain a
PageNode, fetch it and describe its inner nodes too.

### Self-service registration
```
PageNode (entry)                              → outcome
  └ inner: AttributeCollectorNode             (collects email, name, etc.)
CreateObjectNode                              → CREATED → IncrementLoginCountNode → SUCCESS
                                              → FAILURE → FAILURE
```
Source: `Registration` tree.

### Forgot-password / Forgot-username (suspend-and-resume)
```
PageNode (entry, asks identifier)             → outcome
IdentifyExistingUserNode                      → true  → EmailSuspendNode → outcome → ...
                                              → false → SUCCESS (silent — don't leak whether the user exists)
EmailSuspendNode                              → outcome (resumes when user clicks the email link)
PageNode (collect new password) [for reset]   → outcome
PatchObjectNode (write new pw) [for reset]    → PATCHED → SUCCESS
                                              → FAILURE → FAILURE
```
Source: `ResetPassword`, `ForgottenUsername` trees. The "false → success" on
`IdentifyExistingUserNode` is intentional — leaking whether an email exists is
an enumeration vulnerability.

### Progressive profile prompt (show on Nth login)
```
LoginCountDecisionNode (entry)                → true (it's the Nth login) → ProfileCompleteness check → ask
                                              → false → SUCCESS (skip)
QueryFilterDecisionNode / ProfileCompleteness → true (already complete) → SUCCESS
                                              → false → PageNode → AttributeCollector → PatchObjectNode → SUCCESS
```
Source: `ProgressiveProfile` tree.

### Sub-tree composition via InnerTreeEvaluator
```
DataStoreDecisionNode                         → true → IncrementLoginCountNode → InnerTreeEvaluatorNode("ProgressiveProfile") → true → SUCCESS
                                                                                                                              → false → FAILURE
```
Source: `Login` tree (alpha realm). The seed `Login` tree composes
`ProgressiveProfile` (which prompts for missing profile attributes on the Nth
login) — *not* MFA. MFA composition is a common reason to use
`InnerTreeEvaluatorNode`, but it's not what the out-of-the-box Login tree
does in this overlay.

To know which inner tree is being run, fetch the InnerTreeEvaluatorNode
instance — its `tree` config field names the sub-tree.

### Email-OTP MFA (generate → send → collect)

```
OneTimePasswordGeneratorNode (HOTP)     → outcome → OneTimePasswordSmtpSenderNode
OneTimePasswordSmtpSenderNode           → outcome → OneTimePasswordCollectorDecisionNode
OneTimePasswordCollectorDecisionNode    → true    → (next, e.g. SUCCESS)
                                        → false   → (retry path, e.g. RetryLimitDecisionNode)
```

The three nodes communicate via **transient state**, not shared state:

| Key | Type | Producer | Consumer |
|---|---|---|---|
| `oneTimePassword`           | `String` | `OneTimePasswordGeneratorNode` | `OneTimePasswordSmtpSenderNode` reads to put into the email; `OneTimePasswordCollectorDecisionNode` reads to compare against the user's input |
| `oneTimePasswordTimestamp`  | `Long` (ms since epoch) | `OneTimePasswordGeneratorNode` | `OneTimePasswordCollectorDecisionNode` checks against `passwordExpiryTime` (minutes) — if `now > timestamp + passwordExpiryTime*60_000` the OTP is rejected even if the digits match |

**Why this matters for stub/test trees**: if you want to inject a hard-coded
OTP (e.g. `000000` for local dev without SMTP), `SetStateNode` will NOT work —
it writes shared state with **string-only values**, but the collector reads
from **transient** state and expects a `Long` timestamp. The minimum-tools
workaround is a `ScriptedDecisionNode` (declaring `outcomes: ["set"]`) that
seeds transient state. ⚠ On ForgeOps 2025.2 / AM 8.1, `upsert_script` creates
scripts at the **next-gen evaluator (2.0)**, where `transientState` and
`outcome` DON'T EXIST. Use the 2.0 bindings:

```js
nodeState.putTransient("oneTimePassword", "000000");
nodeState.putTransient("oneTimePasswordTimestamp", Date.now());
action.goTo("set");
```

> The legacy form (`transientState.put(...)` + `outcome = "set"`) saves and
> wires fine but throws `ReferenceError: "transientState" is not defined` at
> runtime — explain-tree can't catch it. See the full next-gen API table in
> `am-tree-recipes.md` Recipe 7. (`Date.now()` is correct in both — AM's
> sandbox blocks `java.lang.System.currentTimeMillis()`.) Live-burned 2026-06-10.

This single node replaces both generator and SMTP-sender for a dev tree.
Document the stub clearly — anyone who can see the tree can sign in to any
account whose password they know.

### Update password with current-session check
```
SessionDataNode (entry, pulls username from session) → outcome
PageNode (current pw + new pw)                       → outcome
DataStoreDecisionNode (verify current pw)            → true  → PatchObjectNode → PATCHED → SUCCESS
                                                                                → FAILURE → FAILURE
                                                     → false → AttributePresentDecisionNode (have email?) → true → EmailSuspendNode → ...
                                                                                                          → false → FAILURE
```
Source: `UpdatePassword` tree. Note the email-fallback path: if the user can't
remember their current password, fall through to the email-link recovery path
instead of just failing.

---

## Red flags an explainer should call out

These are patterns that are usually mistakes, not deliberate:

1. **A node has an outcome that is not connected.** Every outcome a node emits
   must be in its `connections` map; a missing key is a dead-end that will
   throw at runtime when AM hits it.
2. **A `connections` value points to a node id that is not in the tree's
   `nodes` map** (and is not one of the two reserved terminals). Indicates a
   stale reference.
3. **`entryNodeId` is not in `nodes`.** Tree won't run.
4. **Decision node with both outcomes pointing to the same target.** Almost
   certainly a bug — why is it a decision then?
5. **`InnerTreeEvaluatorNode` referencing a tree id that doesn't exist.**
   Catch by listing journeys and cross-checking.
6. **PageNode whose inner `nodes` array is empty.** Renders as an empty form;
   user has nothing to do.
7. **`IdentifyExistingUserNode` whose `false` branch leaks information**
   (e.g. routes to a "user does not exist" page). Should silently terminate
   in `SUCCESS` — see the Forgot-Password idiom above.
8. **`DataStoreDecisionNode` followed by `IncrementLoginCountNode` only on
   the `true` branch with no `RetryLimitDecisionNode` between them.** Means
   no rate limiting on login attempts.
