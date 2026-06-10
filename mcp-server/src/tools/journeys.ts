import { z } from "zod";
import { AmClient, AmError } from "../am/client.js";

const TREES_API = "protocol=2.1, resource=1.0";
const TREES_PATH = "/realm-config/authentication/authenticationtrees/trees";

/**
 * AM-wide reserved terminal node UUIDs. Verified to be identical across realms
 * and across freshly-created trees on ForgeOps 2025.2.1 — they're baked into AM,
 * not minted per-realm or per-tree. A node's `connections` point to these for
 * terminal outcomes; `staticNodes` only carries them when the AM admin UI has
 * laid them out for the editor (REST-created trees may have `staticNodes: null`).
 */
export const SUCCESS_NODE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0";
export const FAILURE_NODE_ID = "e301438c-0bd0-429c-ab0c-66126501069a";

const TreeNodeSchema = z.object({
  displayName: z.string().describe("Human-readable name shown in the AM editor (e.g. 'Username Collector')."),
  nodeType: z.string().describe("AM node type id, e.g. 'UsernameCollectorNode'. See list_node_types."),
  x: z.number().optional().describe("Editor x position. Defaults to 0."),
  y: z.number().optional().describe("Editor y position. Defaults to 0."),
  connections: z
    .record(z.string())
    .describe(
      "Outcome → target node id. Use SUCCESS/FAILURE constants for terminals. The outcome names depend on the node type (e.g. 'outcome', 'true'/'false')."
    ),
  version: z.string().optional().describe("Node version. Defaults to '1.0'."),
});

export const getJourneyTerminalsInput = z.object({});

/**
 * Returns the AM-wide success and failure node UUIDs used as terminal targets in
 * any tree's `connections`. These are constants — call once and reuse.
 */
export async function getJourneyTerminals(): Promise<{
  success: string;
  failure: string;
  note: string;
}> {
  return {
    success: SUCCESS_NODE_ID,
    failure: FAILURE_NODE_ID,
    note: "AM-wide reserved UUIDs. Use these as targets in any node's connections map for terminal success/failure outcomes.",
  };
}

export const listJourneysInput = z.object({
  realm: z
    .string()
    .optional()
    .describe(
      "Realm to list journeys from. Defaults to the server's configured realm. Use 'root' for the top-level realm."
    ),
});

export async function listJourneys(
  am: AmClient,
  args: z.infer<typeof listJourneysInput>
): Promise<{
  realm: string;
  count: number;
  journeys: { id: string; description?: string; enabled?: boolean }[];
}> {
  const realm = args.realm ?? "";
  const res = await am.realmGet(`${TREES_PATH}?_queryFilter=true`, realm || undefined);
  return {
    realm: realm || "(server default)",
    count: res.resultCount ?? 0,
    journeys: (res.result ?? []).map((j: any) => ({
      id: j._id,
      description: j.description,
      enabled: j.enabled,
    })),
  };
}

export const getJourneyInput = z.object({
  id: z.string().describe("Journey ID (the tree's name, e.g. 'Login', 'Registration')"),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function getJourney(
  am: AmClient,
  args: z.infer<typeof getJourneyInput>
): Promise<unknown> {
  return am.realmGet(`${TREES_PATH}/${encodeURIComponent(args.id)}`, args.realm, TREES_API);
}

export const createJourneyInput = z.object({
  id: z
    .string()
    .describe("Journey id (also its display name). Becomes the URL segment, so prefer URL-safe characters."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  description: z
    .string()
    .optional()
    .describe("Free-form description shown in the AM editor. Defaults to empty."),
  enabled: z.boolean().optional().describe("Whether the journey is invokable. Defaults to true."),
  entryNodeId: z
    .string()
    .describe(
      "UUID of the first node executed when this journey runs. Must be a key in the supplied 'nodes' map."
    ),
  nodes: z
    .record(TreeNodeSchema)
    .describe("Tree nodes keyed by uuid. Each node references other nodes via its 'connections' map."),
  uiConfig: z
    .record(z.unknown())
    .optional()
    .describe("Optional uiConfig block (categories, etc). Defaults to empty."),
});

export async function createJourney(
  am: AmClient,
  args: z.infer<typeof createJourneyInput>
): Promise<{ id: string; realm: string; entryNodeId: string; nodeCount: number }> {
  if (!args.nodes[args.entryNodeId]) {
    throw new Error(`entryNodeId '${args.entryNodeId}' is not present in 'nodes'`);
  }
  const body = {
    description: args.description ?? "",
    enabled: args.enabled ?? true,
    entryNodeId: args.entryNodeId,
    nodes: args.nodes,
    uiConfig: args.uiConfig ?? {},
    staticNodes: {},
  };
  try {
    const res = await am.realmPut(
      `${TREES_PATH}/${encodeURIComponent(args.id)}`,
      body,
      args.realm,
      TREES_API,
      { "If-None-Match": "*" }
    );
    return {
      id: res._id ?? args.id,
      realm: args.realm ?? "(server default)",
      entryNodeId: res.entryNodeId,
      nodeCount: Object.keys(res.nodes ?? {}).length,
    };
  } catch (err) {
    if (err instanceof AmError && err.status === 412) {
      throw new Error(`Journey '${args.id}' already exists; use update_journey to modify.`);
    }
    throw err;
  }
}

export const updateJourneyInput = z.object({
  id: z.string().describe("Journey id to update."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  description: z
    .string()
    .optional()
    .describe("New description text. Omit to leave unchanged."),
  enabled: z
    .boolean()
    .optional()
    .describe("Set true to enable, false to disable. Omit to leave unchanged."),
  entryNodeId: z
    .string()
    .optional()
    .describe(
      "Change which node is the entry point. Must reference a node already in the tree's nodes map. Omit to leave unchanged."
    ),
});

/**
 * Update journey metadata (description / enabled / entryNodeId).
 * AM's tree PUT is full-replace, so we GET the current tree, merge the
 * supplied fields, and PUT the result. Use edit_journey_edges for node/edge changes.
 */
export async function updateJourney(
  am: AmClient,
  args: z.infer<typeof updateJourneyInput>
): Promise<{ id: string; realm: string; description: string; enabled: boolean; entryNodeId: string }> {
  const current: any = await am.realmGet(
    `${TREES_PATH}/${encodeURIComponent(args.id)}`,
    args.realm,
    TREES_API
  );
  const next = {
    ...current,
    description: args.description ?? current.description,
    enabled: args.enabled ?? current.enabled,
    entryNodeId: args.entryNodeId ?? current.entryNodeId,
  };
  delete next._rev;
  if (args.entryNodeId && !current.nodes?.[args.entryNodeId]) {
    throw new Error(`entryNodeId '${args.entryNodeId}' is not a node in journey '${args.id}'`);
  }
  const res = await am.realmPut(
    `${TREES_PATH}/${encodeURIComponent(args.id)}`,
    next,
    args.realm,
    TREES_API
  );
  return {
    id: res._id,
    realm: args.realm ?? "(server default)",
    description: res.description,
    enabled: res.enabled,
    entryNodeId: res.entryNodeId,
  };
}

export const deleteJourneyInput = z.object({
  id: z.string().describe("Journey id to delete."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function deleteJourney(
  am: AmClient,
  args: z.infer<typeof deleteJourneyInput>
): Promise<{ deleted: { id: string; realm: string } }> {
  await am.realmDelete(`${TREES_PATH}/${encodeURIComponent(args.id)}`, args.realm, TREES_API);
  return { deleted: { id: args.id, realm: args.realm ?? "(server default)" } };
}

export const editJourneyEdgesInput = z.object({
  id: z.string().describe("Journey id to modify."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  edges: z
    .record(z.record(z.string()))
    .describe(
      "Map of nodeId → { outcome → targetNodeId }. Each listed node's connections are replaced wholesale; unlisted nodes are left alone. To remove an outcome, omit it from the inner map for that node."
    ),
  addNodes: z
    .record(TreeNodeSchema)
    .optional()
    .describe(
      "Optional: add or replace entries in the tree's nodes map. Use when introducing a freshly-created node before wiring it."
    ),
  removeNodeIds: z
    .array(z.string())
    .optional()
    .describe(
      "Optional: remove these node ids from the tree. Note this does NOT delete the underlying node object (use delete_node for that)."
    ),
});

/**
 * Rewire a journey's edges and/or add/remove nodes from its `nodes` map.
 * AM's tree PUT is full-replace, so we GET, mutate, PUT.
 */
export async function editJourneyEdges(
  am: AmClient,
  args: z.infer<typeof editJourneyEdgesInput>
): Promise<{
  id: string;
  realm: string;
  changedNodes: string[];
  addedNodes: string[];
  removedNodes: string[];
}> {
  const current: any = await am.realmGet(
    `${TREES_PATH}/${encodeURIComponent(args.id)}`,
    args.realm,
    TREES_API
  );
  const nodes: Record<string, any> = { ...(current.nodes ?? {}) };

  const added: string[] = [];
  if (args.addNodes) {
    for (const [id, node] of Object.entries(args.addNodes)) {
      if (!nodes[id]) added.push(id);
      nodes[id] = {
        version: "1.0",
        x: 0,
        y: 0,
        ...node,
      };
    }
  }

  const removed: string[] = [];
  for (const id of args.removeNodeIds ?? []) {
    if (nodes[id]) {
      delete nodes[id];
      removed.push(id);
    }
  }

  const changed: string[] = [];
  for (const [nodeId, conns] of Object.entries(args.edges)) {
    if (!nodes[nodeId]) {
      throw new Error(`Cannot set edges on '${nodeId}': not in tree (after addNodes/removeNodeIds applied)`);
    }
    nodes[nodeId] = { ...nodes[nodeId], connections: conns };
    changed.push(nodeId);
  }

  const next = { ...current, nodes };
  delete next._rev;
  await am.realmPut(
    `${TREES_PATH}/${encodeURIComponent(args.id)}`,
    next,
    args.realm,
    TREES_API
  );
  return {
    id: args.id,
    realm: args.realm ?? "(server default)",
    changedNodes: changed,
    addedNodes: added,
    removedNodes: removed,
  };
}
