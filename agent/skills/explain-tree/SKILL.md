---
name: explain-tree
description: Walk a ForgeRock AM authentication journey (tree) and produce a structured human-readable explanation. Read-only — never modifies AM state. Use this when the user asks to understand, audit, review, or summarize a journey.
---

# explain-tree

Read-only skill that produces a structured walkthrough of an AM authentication
journey. Use when the user asks to understand, audit, review, or summarize a
tree.

## When to use this

- "Explain the Login journey in alpha"
- "What does the ResetPassword tree do?"
- "Walk me through how the registration flow works"
- "Audit this tree for problems"
- "Why does my journey end at failure?"

If the user asks to *change* a tree, this is the wrong skill — `explain-tree`
never writes. Hand off to `create-tree` / `update-tree` (TBD) after explaining.

## Required references

Both files live at `forgerockmcp/agent/skills/_references/`:

- **`am-node-outcomes.md`** — hand-curated outcome names per node type, plus
  the common multi-node idioms and the red flags to look for. Small (~14 KB);
  read whole. Read its **"Querying the references"** section first — that's
  the recipe for how to consult `am-node-catalog.json` without loading it.
- **`am-node-catalog.json`** — generated catalog of all ~140 AM node types
  with their `name`, `tags`, `help`, and config-field schema. **Don't load
  whole** (~400 KB / ~115K tokens). Query with `jq` per the recipes in
  outcomes.md. Regenerate via `cd forgerockmcp/ops && make node-catalog` if it looks stale.

## Process

### 1. Resolve the inputs

The user names a journey ("the Login tree") and (often) a realm. If the realm
is missing, ask once; do not guess. Default realm conventions: `alpha` is the
standard customer-facing realm in the local stack.

### 2. Fetch the tree

Call `mcp__forgerock__get_journey` with `id` + `realm`. This returns the tree
shape: `entryNodeId`, `nodes` (a map keyed by node UUID, each with
`displayName`, `nodeType`, `connections`), plus tree metadata (`description`,
`enabled`, `mustRun`, `noSession`, `transactionalOnly`, `innerTreeOnly`).

**Always pass `_authToken`** in every MCP tool call. The value is the agent's
copy of the shared MCP secret (in `agent/env/.env` as
`FORGEROCK_AGENT_TOKEN`). Without it the server returns
`Auth error: Missing _authToken`.

### 3. Expand opaque nodes

For each node in the tree where the *outer graph* doesn't tell the full story,
fetch the instance:

- **`PageNode`** — has an inner `nodes` array of callback collectors
  (`ValidatedUsernameNode`, `ValidatedPasswordNode`, `AttributeCollectorNode`,
  etc.). The outer graph only shows the PageNode and its single `outcome`
  edge — you must `mcp__forgerock__get_node` with `type=PageNode` to see what
  the form actually collects.
- **`ScriptedDecisionNode`** — outcomes are declared on the *SDN's*
  `config.outcomes` (NOT the script). Fetch the SDN instance to see them.
  Then call `mcp__forgerock__get_script` with the script id from
  `config.script` to read the source. In the explanation, summarize what the
  script does in one sentence (e.g. "branches on the user's tier from
  sharedState") and list its declared outcomes.
- **`ChoiceCollectorNode`** — outcome names are the configured choices. Fetch
  the instance.
- **`InnerTreeEvaluatorNode`** — runs another tree as a sub-routine. The
  config has `tree`, the id of the inner tree. If the inner tree is well-known
  (`MFA`, `LdapTree`, etc.), name it; otherwise consider recursing — fetch +
  briefly explain the inner tree too.
- **`ConfigProviderNode`** — wraps another node type with externally-supplied
  config; fetch to see the wrapped type.

For any other node type whose name doesn't tell you what it does, query the
catalog for just that type — don't load the whole file:
```bash
jq '.types.<TypeId> | {name, help, tags}' forgerockmcp/agent/skills/_references/am-node-catalog.json
```
The `help` field is usually one sentence and is enough.

### 4. Identify outcome names

For each node's `connections`, you need to know the legal outcome names. In
order of preference:

1. Check `am-node-outcomes.md` — most type-fixed nodes are documented there.
2. If the node is in the "Dynamic outcomes" section (or unknown), GET the
   instance and read its `_outcomes` array.

### 5. Walk paths from entry to terminals

Starting at `entryNodeId`, depth-first walk the graph along each `connections`
key. Stop at:
- A reserved terminal UUID (success: `70e691a5-…` or failure: `e301438c-…` —
  see `get_journey_terminals` for confirmation).
- A node that has no outgoing edge for the current outcome (this is a red
  flag — note it).
- A cycle (loops back to a node already on the current path — usually
  intentional retry logic, occasionally a bug).

Collapse linear chains in the description ("PageNode → DataStoreDecision →
…") so the explanation reads as paths through the journey, not as a node
inventory.

### 6. Detect red flags

Apply the checks from `am-node-outcomes.md`'s "Red flags" section. Most
important:

- Any outcome a node emits that isn't in its `connections` (dead-end branch).
- Any `connections` target that isn't in the tree's `nodes` map and isn't a
  reserved terminal (stale reference).
- `entryNodeId` not in `nodes` (tree is broken).
- Decision node with both outcomes pointing to the same target (probable bug).
- `IdentifyExistingUserNode` `false` branch leaking enumeration info.
- A node pinned to an older `version` than AM currently registers for its type
  (compare the tree's `nodes[<uuid>].version` against `get_node`'s
  `_type.version` for that type). Often harmless, but flag it — a node left at
  `"1.0"` while AM ships a newer version can run an older config schema than
  intended. Note it; fixing is `update-tree`'s job, not this skill's.

## Output template

Use Markdown. Sections in this order:

```markdown
## <TreeName> in realm <realm>

**One-line summary**: <e.g. "Username + password login with optional MFA via inner tree">

**Status**: <enabled/disabled>; <node count> nodes

### Paths

For each distinct path from entry to a terminal:

1. **Path: <outcome label, e.g. "Successful login">**
   `<EntryNode>` → ... → `SUCCESS`
   - <node-by-node narrative, calling out what each non-trivial node does>
   - <inner PageNode contents inline where relevant>

2. **Path: <next outcome, e.g. "Bad password">**
   `<EntryNode>` → ... → `FAILURE`
   - <narrative>

### Notable details

- <e.g. "PageNode collects username + password via ValidatedUsername/ValidatedPassword (server-side validation, not just client-side)">
- <e.g. "MFA is composed via InnerTreeEvaluator pointing at the `MFA` tree, which we should explain separately if the user needs the full picture">

### Red flags

- <list anything from the red-flags checklist that triggered, OR>
- "None — graph is well-formed."
```

Keep the path narratives terse — one line per node hop, two if it's a decision
node where both branches matter. Reserve detail for things the user can't
infer from the diagram.

## Things to NOT do

- Don't dump the raw `get_journey` JSON — that defeats the point.
- Don't enumerate every UUID — they're noise. Use display names + node types.
- Don't write the explanation before fetching every PageNode's inner config.
  Skipping this consistently produces wrong explanations of login/registration
  trees because you'll claim the form has a single field when it has two.
- Don't infer what a script does without reading it. `mcp__forgerock__get_script`
  is cheap — call it. *Do* summarize the source briefly; *don't* paste the
  whole source unless the user asks.
- Don't infer the realm. Ask if the user didn't specify.

## Example invocations

| User says | Skill behavior |
|---|---|
| "Explain the Login tree in alpha" | Fetch → expand PageNode → walk → format. |
| "What's wrong with my UpdatePassword tree?" | Same fetch + expand, but lead with the red-flags section. |
| "Walk me through Registration" | Same fetch + expand. |
| "Explain Login" (no realm) | Ask: "Which realm? alpha or root?" |
| "Compare Login and Registration" | Run the skill twice; present them side-by-side; flag shared subgraphs. |
