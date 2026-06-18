---
name: update-tree
description: Modify an existing ForgeRock AM authentication journey (tree) — rewire edges, add nodes, remove nodes, swap a node type, toggle enabled, change description or entry. Plan-first, diff-first. Use this when the user asks to change, edit, fix, extend, or refactor an existing tree. Writes to AM via the mcp__forgerock__* tools.
---

# update-tree

Plan-first skill for modifying existing AM journeys. Always shows the user a
diff (current → proposed) before writing anything. Always verifies after the
edit by handing off to `explain-tree`.

## When to use this

- "Add a retry limit to MyLogin"
- "Insert an IncrementLoginCount before SUCCESS on the Login tree"
- "Disable the ResetPassword tree"
- "Change the entry point of MyLogin to <node>"
- "Replace the DataStoreDecision in MyLogin with a ScriptedDecision"
- "Remove the ProgressiveProfile sub-tree call from Login"
- "Fix the dead-end branch on my UpdatePassword tree"

If the user wants to *build a new tree*, use `create-tree`. If they want to
*understand* a tree, use `explain-tree` (and consider running it before this
skill anyway — see step 2).

## Required references

All under `forgerockmcp/agent/skills/_references/`:

- **`am-node-outcomes.md`** — outcome names per node type, multi-node idioms,
  red flags. Critical for getting `connections` right when rewiring. Small
  (~14 KB); read whole. Its **"Querying the references"** section has the
  jq recipes for consulting the catalog without loading it.
- **`am-tree-recipes.md`** — 7 worked recipes. When the user's edit *recreates*
  a well-known idiom (e.g. "add brute-force protection" ≈ Recipe 1b),
  borrow the recipe's shape rather than inventing one. Index it first:
  ```bash
  grep -n -i -B 1 "user intent" forgerockmcp/agent/skills/_references/am-tree-recipes.md
  ```
- **`am-node-catalog.json`** — generated, ~115K tokens. **Don't load whole.**
  Query with `jq` (recipes in outcomes.md) when you need a schema for a node
  type the edit introduces.

## What the underlying tools support

The four MCP primitives you'll combine. Know the edges:

- **`mcp__forgerock__edit_journey_edges`** — the workhorse. Takes an `edges`
  map (`nodeId → {outcome: targetId}`); each listed node's connections are
  **replaced wholesale** (unlisted nodes left alone). Optional `addNodes`
  introduces or replaces entries in the tree's `nodes` map (use this *after*
  `upsert_node`-ing the node body). Optional `removeNodeIds` drops nodes from
  the tree's map (does NOT delete the underlying node record — see below).
  Internally reads-mutates-writes the tree because AM's PUT is full-replace.
- **`mcp__forgerock__update_journey`** — tree-level scalars only:
  `description`, `enabled`, `entryNodeId`. Does NOT touch the nodes map or
  edges. Use this for "disable X" / "rename Y" / "change entry to Z".
- **`mcp__forgerock__upsert_node`** — create or replace a node record (its
  config + type). Required when introducing a new node OR when changing an
  existing node's config (e.g. bumping `retryLimit` from 3 to 5).
- **`mcp__forgerock__delete_node`** — deletes the underlying node record.
  Doesn't touch any tree that references it — so remove the tree's edges to
  it first. After a successful `delete_journey`, AM 8 *cascades* deletion of
  nodes referenced only by that tree, so you usually don't need to call this.
  When trimming nodes from a still-live tree, you do.

## Process

### 1. Resolve inputs

- **Realm** + **tree id**. Don't guess; ask once if not stated.
- **What to change.** Underspecified asks ("make MyLogin better") produce bad
  diffs — pin down: which node? which edge? what new behavior? what should
  it look like after?

### 2. Read the current tree (always)

Call `mcp__forgerock__get_journey` first. Editing without re-reading is the
single most common way to corrupt a tree. The tree may have been changed by
the admin UI or another agent since you last saw it.

If the user's intent is fuzzy or the tree is non-trivial, run the
`explain-tree` skill against the live tree before planning the edit. Its
output gives you the path narratives you'll diff against in step 3.

**Expand opaque nodes** the same way `explain-tree` does:
- `PageNode` — fetch with `get_node` to see inner collector references.
- `ScriptedDecisionNode` — outcomes live on the SDN's `config.outcomes`, not
  the script. Fetch the SDN before assuming outcome names.
- `InnerTreeEvaluatorNode` — note the inner tree id but don't recurse unless
  the edit touches it.
- Dynamic-outcome types (`ChoiceCollectorNode`, `ConfigProviderNode`,
  `ConsentNode`) — fetch the instance.

### 3. Plan-as-diff (DO NOT WRITE YET)

Produce a Markdown plan and stop. Required parts:

```markdown
## Edit plan: <TreeId> in <realm>

**Intent**: <one-line restatement of what the user asked for>

**Idiom match**: Recipe N (<name>), or "no recipe — pure rewire"

### Diff

**Before** (relevant slice of current wiring):

#3 PageNode             outcome → #4
#4 DataStoreDecision    true    → SUCCESS
                        false   → FAILURE

**After**:

#3 PageNode             outcome → #4
#4 DataStoreDecision    true    → SUCCESS
                        false   → #5  ← changed
#5 RetryLimitDecision   Retry   → #3  ← new
                        Reject  → FAILURE

### Node operations

| # | Op            | Type/Id                                  | Notes |
|---|---------------|------------------------------------------|-------|
| a | upsert_node   | RetryLimitDecisionNode `<U_retry>`       | config: `{retryLimit: 3, incrementUserAttributeOnFailure: false}` |
| b | edit_journey_edges | rewire #4, addNodes={#5}            | one call carries everything |

### Tree-level changes

- `description`: unchanged
- `enabled`: unchanged
- `entryNodeId`: unchanged

### Nodes orphaned by this edit

- None / <list any node ids whose only reference was a removed edge>

### Schema lookups still needed

- None / get_node_type_schema for <type>

### Risk of breakage

- Sessions mid-flight when this writes: AM PUT is full-replace; existing
  sessions follow their cached path. New sessions pick up the new tree.
- Cascading delete on tree-delete (N/A here — we're editing, not deleting).

Reply "go" to apply, or correct anything above.
```

Do not call any write tool until the user replies. Diffs are cheap; broken
trees aren't.

### 4. Resolve unknowns

For any node type the edit introduces, fetch its config schema. Prefer the
local catalog:

```bash
jq '.types.<TypeId>' forgerockmcp/agent/skills/_references/am-node-catalog.json
```

…or `mcp__forgerock__get_node_type_schema` if you suspect the catalog is
stale (post-forgeops upgrade).

If the schema disagrees with what the plan assumed (field renamed, new
required field), update the plan and re-check with the user before writing.

### 4b. Validate every outcome name in the diff (HARD GATE)

Before issuing `edit_journey_edges` (or `create_journey`), every key under
every node's `connections` must be a documented outcome for that node's type.
This is not optional, and it is the most common source of silently-broken
trees, because AM accepts unknown outcome keys at write time and only fails
at runtime when the node is reached.

For **every** node that appears in your `edges`, `addNodes`, OR whose existing
edges remain unchanged but get a new target, run this check:

1. **Type-fixed nodes** — look the type up in `am-node-outcomes.md`'s tables.
   Use those exact outcome strings (case-sensitive).
   Notable non-`true`/`false` cases to double-check from memory:
   - `RetryLimitDecisionNode` → `Retry` / `Reject` (NOT true/false)
   - IDM CRUD nodes (`PatchObjectNode`, `CreateObjectNode`) → `PATCHED` / `CREATED` + `FAILURE` (NOT `outcome`)
   - MFA nodes (Push/WebAuthn/Oath) → `success` / `failure` + extras
   - PageNode and pure-action nodes → single `outcome`
2. **Dynamic-outcome nodes** (ScriptedDecisionNode, ChoiceCollectorNode,
   ConfigProviderNode, ConsentNode) — the outcomes come from the node's own
   config. For an SDN you're upserting, the outcomes are whatever you put in
   `config.outcomes`. For an existing instance, fetch with `get_node` and
   read its `_outcomes` array.
3. **Anything not in either** — fetch the live instance with `get_node`; its
   response includes `_outcomes`. If still unsure, ask before writing.

For every outcome the node emits but your edit doesn't connect, decide
explicitly: route to a terminal, route somewhere else, or accept the
dead-end (rare and usually a bug). Don't silently omit outcomes — see
"Never edit `connections` partially" in the don't-list.

If the validation step finds a mismatch (you'd planned `outcome` but the type
emits `PATCHED`/`FAILURE`, for example), regenerate the diff and re-confirm
with the user. A single wrong outcome key is enough to take a path dead at
runtime; the write itself will succeed and look fine.

### 4c. Use the latest node version (for any node you add)

Each entry in a tree's `nodes` map carries a `version` (the node-type version
AM uses to interpret it) — separate from the node record; `upsert_node` has no
version arg. ⚠ **`edit_journey_edges` `addNodes` defaults a node's `version` to
`"1.0"` when you omit it** (same default `create_journey` uses). For any node
this edit *introduces*, prefer the latest version AM actually supports and set
it explicitly in the `addNodes` entry, rather than shipping the 1.0 default.

Discover the current version with the tools you have (prefer the first):

1. **Live instance** — `get_node {type, id}`; the response's `_type.version` is
   the version AM currently registers for that type.
2. **Seed tree** — `get_journey` on an AM-created seed tree, then read
   `nodes[<uuid>].version` of an entry with the same `nodeType`.
3. **Can't determine it** — `"1.0"` is correct for most AM 8.1 nodes; override
   only when discovery shows higher, and note the assumption in the diff.

For nodes you're **only rewiring** (not adding), leave their existing `version`
alone — `edit_journey_edges` preserves it; don't gratuitously bump versions as
part of an unrelated edit.

### 5. Apply

Order matters. Do it bottom-up so a partial failure leaves a clean tail:

1. **New node bodies first** — one `upsert_node` per new node (or modified
   config). The node exists but isn't wired into anything yet.
2. **Re-config of *existing* nodes** — `upsert_node` with the same id replaces
   the record. The tree's edges to it survive (edges live on the tree, not
   the node).
3. **Rewire in one `edit_journey_edges` call** — pass `edges` for every
   changed source node, `addNodes` for any new node to insert into the tree's
   map, `removeNodeIds` for any node to drop from the tree's map. Doing it
   in one call keeps the tree consistent (no half-applied state mid-edit).
   Set `version` explicitly on each `addNodes` entry (step 4c) — omitting it
   stamps `"1.0"`.
4. **Tree-level changes**, if any — one `update_journey` call.
5. **Delete orphaned node records**, if any. `edit_journey_edges` with
   `removeNodeIds` only removes them from the *tree's* map; the underlying
   record still exists (and counts against `list_all_nodes`). If nothing else
   references it, call `delete_node` to clean up.

If any call fails, **stop**. Don't try to keep going. The tree may now be
half-edited; report the state and ask the user how to proceed (often: roll
back the changes you did make, then re-plan).

### 6. Verify with explain-tree

As soon as the last write returns success, hand off to `explain-tree` against
the modified tree. Read its output back to the user and confirm:

- The new path narratives match the intent from step 1.
- No red flags that weren't there before (or, if any, called out explicitly).
- No dead-end branches (outcome on a node with no `connections` target).
- No stale references (target id not in the tree's `nodes` map and not a
  reserved terminal).
- **`_rev` changed** between the pre-edit `get_journey` (step 2) and the
  post-edit `get_journey` (verify step). If `edit_journey_edges` or
  `update_journey` returned a success body that reports `changedNodes`,
  `addedNodes`, `removedNodes`, or a scalar update — but `_rev` is unchanged —
  something is off (write swallowed, or you're reading a different replica).
  Stop and investigate before claiming success.

If explain-tree reveals a wiring mistake, fix it with another
`edit_journey_edges` call — no need to delete and rebuild.

## Common edit patterns

### Insert a node mid-edge

User: *"Insert IncrementLoginCount between the DataStoreDecision true outcome
and SUCCESS in MyLogin."*

1. `upsert_node` IncrementLoginCountNode `<U_inc>` (config `{}`).
2. `edit_journey_edges`:
   ```js
   {
     edges: {
       "<U_dsdec>": { true: "<U_inc>", false: "<U_retry-or-FAILURE>" },
       "<U_inc>":   { outcome: "70e691a5-…SUCCESS" }
     },
     addNodes: {
       "<U_inc>": { displayName: "Count Login", nodeType: "IncrementLoginCountNode", x: 600, y: 100, connections: { outcome: "70e691a5-…SUCCESS" }}
     }
   }
   ```

Note `addNodes` and `edges` *both* mention the new node — that's by design.
`addNodes` puts it in the tree's nodes map; `edges` sets the source edges.
A single new node's *own* outgoing edges can be expressed in either (both
work; `addNodes.connections` is what AM persists). Keeping both consistent
is safest.

### Add brute-force protection to a login tree

This is Recipe 1 → Recipe 1b. The diff is one new node + one rewired edge.

1. `upsert_node` RetryLimitDecisionNode `<U_retry>` with
   `{retryLimit: 3, incrementUserAttributeOnFailure: false}`.
2. `edit_journey_edges`:
   ```js
   {
     edges: { "<U_dsdec>": { true: SUCCESS, false: "<U_retry>" } },
     addNodes: {
       "<U_retry>": { displayName: "Retry?", nodeType: "RetryLimitDecisionNode", x: 600, y: 100, connections: { Retry: "<U_pageform>", Reject: FAILURE }}
     }
   }
   ```

> ⚠ `RetryLimitDecisionNode` outcomes are `Retry`/`Reject` — NOT `true`/`false`.
> Caught in create-tree sanity. See outcomes.md.

### Swap a decision-node implementation

User: *"Replace the DataStoreDecision in MyLogin with a ScriptedDecision that
also checks the user's department."*

1. `upsert_script` for the SDN source. ⚠ On this stack (ForgeOps 2025.2 /
   AM 8.1) `upsert_script` creates **next-gen `evaluatorVersion "2.0"`**
   scripts: select the outcome with `action.goTo("<name>")` (NOT the legacy
   `outcome = "..."`), use `nodeState` (NOT `sharedState`/`transientState`),
   `callbacksBuilder.*` to prompt, `callbacks.getNameCallbacks().get(0)` to read
   input. `idRepository.getIdentity()` needs the **uuid** (resolve via an
   `IdentifyExistingUserNode` → `_id`), and **never `.iterator()` a returned
   `List`** (sandbox-blocked — use `.get(0)`). Legacy-API or `.iterator()`
   scripts save, wire, and pass explain-tree but throw at runtime (HTTP 401) —
   see Recipe 7 for the 2.0 API table.
2. `upsert_node` ScriptedDecisionNode `<U_sdn>` with `config.outcomes`
   declared (e.g. `[{id:"allow",displayName:"allow"},{id:"deny",displayName:"deny"}]`)
   and `config.script` = the script id.
3. `edit_journey_edges`:
   ```js
   {
     edges: {
       "<U_pageform>": { outcome: "<U_sdn>" },   // rewire entry-side
       "<U_sdn>":      { allow: SUCCESS, deny: FAILURE }
     },
     addNodes: { "<U_sdn>": { displayName: "Verify+Dept", nodeType: "ScriptedDecisionNode", x: 350, y: 100, connections: { allow: SUCCESS, deny: FAILURE }}},
     removeNodeIds: ["<U_dsdec>"]
   }
   ```
4. Optional: `delete_node` on the orphaned DataStoreDecision if no other tree
   references it.

### Disable a tree / rename / move entry

Pure scalar edit:

```js
update_journey({ id: "MyLogin", enabled: false })
update_journey({ id: "MyLogin", description: "Disabled while we migrate" })
update_journey({ id: "MyLogin", entryNodeId: "<U_someExistingNode>" })
```

No `edit_journey_edges` needed. No verify step needed for `enabled`/`description`
toggles, but DO run explain-tree if `entryNodeId` changes (new path narratives).

### Trim a dead-end

`explain-tree` reports "node X emits outcome Y but no edge for it." Fix:

```js
edit_journey_edges({
  id: "...",
  edges: { "<X>": { ...existing, Y: "e301438c-…FAILURE" } }  // or wherever it should go
})
```

If the missing edge means a node is now unreachable in *all* paths, decide
with the user whether to remove it (`removeNodeIds` + optional `delete_node`)
or wire it in.

## Things to NOT do

- **Never write before the user says go on the plan.** The plan-as-diff is
  the safety net. Even "small" rewires can break a tree in ways that look
  fine to a human glance.
- **Never call `edit_journey_edges` without first re-reading the tree.** Trees
  drift (admin UI edits, other agents). The tool reads-mutates-writes
  internally, but your *plan* still has to match current reality.
- **Never edit `connections` partially.** `edit_journey_edges` replaces a
  source node's connections wholesale — if you list `{true: SUCCESS}` for a
  node that previously also had `false: FAILURE`, the `false` edge is gone.
  Always include every outcome the node should keep.
- **Never assume outcome names without checking** the references or a live
  `_outcomes` array. `edit_journey_edges` doesn't validate outcome names
  against the node type at write time — typos and wrong-by-convention names
  (`outcome` for an IDM CRUD node, `true`/`false` for `RetryLimitDecisionNode`)
  make it through the write and break at runtime when execution reaches the
  node. Step 4b of the Process is the hard gate; do not skip it.
- **Never `delete_node` a node that's still referenced by a tree.** AM will
  let you, but the tree then has a stale reference. Always `edit_journey_edges`
  with `removeNodeIds` (or rewire away) first; *then* `delete_node`.
- **Never combine an unrelated refactor with the user's requested edit.** If
  you spot other red flags while reading the tree, mention them in the plan's
  "additional observations" section — let the user decide whether to bundle.
  One edit, one diff.
- **Never skip the verify step.** Especially for rewires touching more than
  one edge. explain-tree is cheap and catches the wiring mistakes.
- **Never edit a tree's `nodes` map via `update_journey`** — it doesn't take
  one. Use `edit_journey_edges`'s `addNodes` / `removeNodeIds`.
- **Never let an added node's `version` silently default.** `addNodes` stamps
  `"1.0"` for any node without an explicit `version`. When AM registers a newer
  version for the type, set it (step 4c) so the graph matches the upserted
  config. (Rewiring an existing node doesn't touch its version — that's fine.)

## Example walkthrough: "Add a retry limit to MyLogin (3 attempts)"

1. **Resolve**: realm=alpha (given context), tree=MyLogin, intent="rate-limit
   the bad-password path." Confirm retryLimit value: "3?"
2. **Read**: `get_journey MyLogin` in alpha. Current shape (the plain-login
   we just built): PageNode → DataStoreDecision (true→SUCCESS, false→FAILURE).
3. **Plan-as-diff**: render the diff above. Idiom match: Recipe 1b. Stop.
4. **User says "go"**.
5. **Resolve unknowns**: schema for RetryLimitDecisionNode confirms
   `retryLimit` + `incrementUserAttributeOnFailure` are the fields. Outcomes
   are `Retry`/`Reject` (from outcomes.md).
6. **Apply**:
   - `upsert_node` RetryLimitDecisionNode `<U_retry>` with config.
   - `edit_journey_edges`: rewire DataStoreDecision's `false` to `<U_retry>`;
     add `<U_retry>` to the tree with `Retry → PageNode`, `Reject → FAILURE`.
7. **Verify**: `explain-tree MyLogin`. Should now show three paths:
   success, bad-creds-under-limit (loops via PageNode), bad-creds-exhausted
   (FAILURE). Red flag #8 should be cleared.
