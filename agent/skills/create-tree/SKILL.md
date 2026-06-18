---
name: create-tree
description: Build a new ForgeRock AM authentication journey (tree) from scratch. Plan first, write second. Use this when the user asks to create a tree, build a flow, or "make me a journey that does X". Writes to AM via the mcp__forgerock__* tools.
---

# create-tree

Plan-first skill for building new AM journeys. Always shows the user a build
plan before writing anything to AM. Always verifies after building by handing
off to `explain-tree`.

## When to use this

- "Create a Login tree in alpha"
- "Build a registration flow with email verification"
- "I need a forgot-password journey"
- "Make me a custom MFA tree that…"

If the user asks to *modify* an existing tree, use `update-tree` (TBD)
instead. If they want to *understand* a tree, use `explain-tree`.

## Required references

All under `forgerockmcp/agent/skills/_references/`:

- **`am-node-outcomes.md`** — outcome names per node type, multi-node idioms,
  and the red flags. Critical for getting `connections` right. Small (~14 KB);
  read whole. Read its **"Querying the references"** section first — it has
  the recipes for consulting the catalog and recipes file efficiently.
- **`am-tree-recipes.md`** — 7 worked recipes covering the common idioms
  (each is a complete `upsert_node` + `create_journey` build). Don't load the
  whole file (~17 KB but growing) — index it first:
  ```bash
  grep -n -i -B 1 "user intent" forgerockmcp/agent/skills/_references/am-tree-recipes.md
  ```
  Then read just the matching recipe section. Match the user's intent to one
  of these *first*; only build from scratch if nothing matches.
- **`am-node-catalog.json`** — generated catalog of all ~140 node types.
  **Don't load whole** (~115K tokens). Query with `jq` per the recipes in
  outcomes.md. Read this when you need config fields for a node type that
  isn't in a recipe.

## Process

### 1. Clarify intent

"Create a tree that does X" is almost always underspecified. Before you reach
for any tool, get answers to:

- **Realm**: where does the tree live? Don't guess — ask if not stated.
- **Tree id**: what should it be called? AM uses the id as both URL segment
  and display name; prefer URL-safe, no spaces.
- **Entry point**: what should the user see first? (Form, decision, session
  read, …)
- **Success path**: what does success mean for this tree? Where does it land?
- **Failure handling**: silent fail, error page, retry?
- **IDM side effects**: does the tree create or modify a managed user? With
  what fields?
- **Sub-tree composition**: does this tree run another tree
  (`InnerTreeEvaluatorNode`)? If so, which?

Don't move on until you have working answers to each. Vague intents produce
trees that look right and break in production.

### 2. Match a recipe (or note that none fits)

Read `am-tree-recipes.md`. Pick the recipe whose **user intent** line matches
the clarified request, or pick the closest variant:

| User wants                                   | Recipe       |
|----------------------------------------------|--------------|
| Plain username/password login                | 1            |
| Login with brute-force protection            | 1b           |
| Self-service registration                    | 2            |
| Forgot-password (email link reset)           | 3            |
| Forgot-username (email the username)         | 4            |
| Progressive profile prompt                   | 5            |
| Update password (with email fallback)        | 6            |
| Custom branching via ScriptedDecisionNode    | 7            |

If the request *combines* recipes (e.g. "registration + email verification"),
build the combination by composing the individual recipes' nodes. Ask the user
to confirm the combination interpretation before planning.

If nothing matches, see "Building from scratch" below.

### 3. Plan first (DO NOT WRITE YET)

Produce a Markdown build plan and stop. The plan has four parts:

```markdown
## Build plan: <TreeId> in <realm>

**Idiom**: Recipe N (<name>) — adapted for <user-specific tweak>

**Nodes** (each will be a separate upsert_node call):

| # | Type                       | Display name | Notes |
|---|----------------------------|--------------|-------|
| 1 | ValidatedUsernameNode      | Username     |       |
| 2 | ValidatedPasswordNode      | Password     |       |
| 3 | PageNode                   | Login Form   | wraps #1 + #2 |
| 4 | DataStoreDecisionNode      | Verify       | true→success, false→#5 |
| 5 | RetryLimitDecisionNode     | Retry?       | retryLimit=3; true→#3, false→FAILURE |

**Wiring** (the tree's connections):

#3 (PageNode)              outcome → #4
#4 (DataStoreDecision)     true    → SUCCESS
                           false   → #5
#5 (RetryLimit)            true    → #3 (back to form)
                           false   → FAILURE

**Entry**: #3
**Sub-trees referenced**: none
**Node versions**: latest per type (e.g. all 1.0 on this stack — confirmed via get_node `_type.version` / seed tree)
**Schema lookups still needed**: get_node_type_schema for RetryLimitDecisionNode (config field name)

Reply "go" to build, or correct anything above.
```

Do not call `upsert_node` or `create_journey` until the user replies. Brief
back-and-forth is the goal — multiple rounds are fine.

### 4. Look up the unknowns

Before building, resolve any "schema lookups still needed" items. Two
options, prefer the first:

- **Local catalog query** (free, instant, offline-OK):
  ```bash
  jq '.types.<TypeId>' forgerockmcp/agent/skills/_references/am-node-catalog.json
  ```
- **Live AM lookup** (`mcp__forgerock__get_node_type_schema`) — use when you
  need to verify against the running AM (e.g. a recent forgeops upgrade may
  have added fields the catalog dump doesn't yet have).

If the schema disagrees with what the recipe assumed (field renamed, new
required field), update the plan and re-check with the user.

For dynamic-outcome node types (ChoiceCollectorNode, ScriptedDecisionNode,
ConfigProviderNode, ConsentNode — see `am-node-outcomes.md`), be honest: the
outcome names depend on the config you're about to write. Plan the outcome
names explicitly and confirm with the user before wiring.

### 4b. Use the latest node version

Each entry in a tree's `nodes` map carries a `version` (the node-type version
AM uses to interpret that node). It is **separate** from the node record:
`upsert_node` has no version arg — version is a tree-graph attribute, set in
the `create_journey` `nodes` map (and in `edit_journey_edges` `addNodes`).

⚠ **`create_journey` defaults every node's `version` to `"1.0"` when you omit
it.** Most AM 8.1 node types are still at 1.0, but some ship higher. Pinning a
node at 1.0 when AM registers a newer version can load an older config schema
or behavior than the config you wrote with `upsert_node` expects. **Prefer the
latest version AM actually supports for each type, and set it explicitly** —
don't rely on the default.

Discover the current version with the tools you already have (prefer the
first):

1. **Live instance** — `get_node {type, id}` on any existing node of that type;
   the response's `_type.version` is the version AM currently registers.
2. **Seed tree** — `get_journey` on an AM-created seed tree, then read
   `nodes[<uuid>].version` for an entry of the same `nodeType`; that's what
   AM's own bootstrap stamped (i.e. current).
3. **Can't determine it** — `"1.0"` is correct for the large majority of AM 8.1
   nodes; only override when discovery shows higher. Note the assumption in the
   plan.

### 5. Build bottom-up

Generate fresh UUIDs for each node (one per node — never reuse seed UUIDs).
Then in this order:

1. **Standalone callback collectors first**
   (`ValidatedUsernameNode`, `ValidatedPasswordNode`, `AttributeCollectorNode`).
2. **PageNodes that wrap them**, with `config.nodes` referencing the collectors'
   ids by `{_id, displayName, nodeType}`.
3. **Decision and action nodes** (DataStoreDecision, PatchObject,
   EmailSuspend, etc.) — order doesn't matter among these.
4. **`create_journey`** with the full `nodes` map and the `entryNodeId`.

Doing it bottom-up means a partial failure leaves only standalone nodes (cheap
to clean up) instead of a half-built tree (referenced from elsewhere, harder
to remove).

If `upsert_node` fails, stop and surface the error. Don't try to keep going.

### 6. Verify with explain-tree

As soon as `create_journey` returns success, hand off to `explain-tree` with
the new tree id. Read its output back to the user. Confirm:

- The path narratives match the original intent.
- Red flags section is empty (or, if any are intentional, call them out
  explicitly — e.g. "yes, no rate limit, you said this is for an internal
  test environment").

If the explanation reveals wiring mistakes, fix with
`mcp__forgerock__edit_journey_edges` (no need to delete and rebuild).

## Building from scratch (no recipe matches)

When intent doesn't fit any recipe:

1. **Decompose** the requirement into ordered steps:
   `collect input → check condition → take action → terminate`.
2. **Pick a node type per step** by querying the catalog. Common tags:
   `basic authn`, `risk`, `mfa`, `utilities`, `behavioral`, `federation`,
   `social`, `iot`, `otp`, `idm`. List live tags with
   `jq -r '[.types[].tags[]]|unique|.[]' forgerockmcp/agent/skills/_references/am-node-catalog.json`.
   Or do a keyword search across name/help/tags — see "Querying the references"
   in `am-node-outcomes.md`.
3. **Fetch each picked type's config schema** with `get_node_type_schema`.
4. **Find each picked type's outcomes** in `am-node-outcomes.md`. If absent,
   GET an existing instance (look in alpha's seed trees with `list_journeys`
   + `get_journey`).
5. **Sketch the wiring as a plan first** (step 3 above). Then build.

## Things to NOT do

- **Never write before the user says go on the plan.** Trees are
  cross-referenced from other trees and from realm config; cleanup is
  annoying.
- **Never reuse seed-tree UUIDs.** Build fresh. Cloning the seed nodes
  creates ownership confusion (AM cascades node deletion through trees that
  reference them).
- **Never inline a PageNode's child config.** PageNode `config.nodes` is an
  array of *references* to separately-existing nodes:
  `[{_id, displayName, nodeType}]`. The actual collector nodes
  (ValidatedUsername, AttributeCollector, etc.) must be `upsert_node`'d
  first.
- **Never assume an outcome name without checking** the references or a live
  `_outcomes` array. AM rejects an `edit_journey_edges` call that targets a
  non-existent outcome — but `create_journey` does not validate outcome names
  against the node types, so a typo can make it through and break at runtime.
- **Never skip the verify step.** Even simple-looking trees can be wrong in
  ways that look right to a human glance but explain-tree will catch.
- **Never let node `version` silently default.** `create_journey` stamps any
  node you don't give a `version` as `"1.0"`. When AM registers a newer version
  for that type, set it explicitly (step 4b) so the graph matches the config
  you upserted — don't ship the silent default unchecked.
- **Scripts are separate from nodes — call them in the right order.** When
  building with `ScriptedDecisionNode`, the order is `upsert_script` →
  `upsert_node ScriptedDecisionNode (referencing the script id)` →
  `create_journey`. Outcomes are declared on the SDN's `config.outcomes`,
  NOT on the script. The script's job is to select one of those names.
  **⚠ On this stack (ForgeOps 2025.2 / AM 8.1) `upsert_script` creates
  next-gen `evaluatorVersion "2.0"` scripts — the legacy 1.0 API does NOT
  exist there.** Use `action.goTo("<name>")` (NOT `outcome = "..."`),
  `nodeState.get/putShared/putTransient` (NOT `sharedState`/`transientState`),
  `callbacksBuilder.*` to prompt, and `callbacks.getNameCallbacks().get(0)` to
  read input. Legacy-API scripts save, wire, and pass explain-tree but throw at
  runtime (HTTP 401). Two sandbox traps that also only fail at runtime:
  `idRepository.getIdentity()` needs the user's **uuid** not uid (resolve it
  with an `IdentifyExistingUserNode` → `_id`), and **never `.iterator()` a
  returned `List`** — it's blocked; use `.get(0)`. See Recipe 7 for the full
  2.0 API table and a worked prompt-and-verify example.

## Example walkthroughs

### "Make me a login tree in alpha called MyLogin with rate limiting"

1. **Clarify**: realm=alpha (given), id=MyLogin (given), success/failure
   destinations default, retry limit value? *Ask*: "How many failed attempts
   before lockout? 3?"
2. **Match**: Recipe 1b (login + retry limit).
3. **Plan**: Render the table from Recipe 1b with retryLimit=3 substituted in.
   Stop.
4. **User says "go"**.
5. **Look up**: `get_node_type_schema RetryLimitDecisionNode` to confirm the
   field name (recipe says `retryLimit`; AM may use `retryLimitCount` or
   similar).
6. **Build**: 5 `upsert_node` calls (Username, Password, PageNode,
   DataStoreDecision, RetryLimit) → 1 `create_journey`.
7. **Verify**: Run `explain-tree` on `MyLogin`. Should show 3 paths: success,
   bad creds within limit (loops back), bad creds exhausted (FAILURE). No red
   flags expected.

### "Build a tree that does X" where X is unfamiliar

1. **Clarify** until you understand it.
2. **No recipe matches** — note that explicitly.
3. **Decompose** into steps, pick types via `list_node_types` (filtered by
   tag), fetch schemas, look up outcomes.
4. **Plan**, stop, wait.
5. **Build, verify** as usual.
6. **Consider proposing** that this becomes a new recipe in
   `am-tree-recipes.md` if it's a pattern that might recur.
