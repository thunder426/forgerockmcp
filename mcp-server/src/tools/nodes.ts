import { z } from "zod";
import { AmClient, AmError } from "../am/client.js";

const NODES_API = "protocol=2.1, resource=1.0";
const NODES_PATH = "/realm-config/authentication/authenticationtrees/nodes";

export const listNodeTypesInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function listNodeTypes(
  am: AmClient,
  args: z.infer<typeof listNodeTypesInput>
): Promise<{ count: number; types: { id: string; name: string; tags: string[]; help?: string }[] }> {
  const res = await am.realmPost(`${NODES_PATH}?_action=getAllTypes`, {}, args.realm, NODES_API);
  const types = (res.result ?? []).map((t: any) => ({
    id: t._id,
    name: t.name,
    tags: t.tags ?? [],
    help: t.help,
  }));
  return { count: types.length, types };
}

export const getNodeTypeSchemaInput = z.object({
  type: z.string().describe("Node type id, e.g. 'UsernameCollectorNode'."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function getNodeTypeSchema(
  am: AmClient,
  args: z.infer<typeof getNodeTypeSchemaInput>
): Promise<{ type: string; required: string[]; properties: Record<string, unknown> }> {
  const res = await am.realmPost(
    `${NODES_PATH}/${encodeURIComponent(args.type)}?_action=schema`,
    {},
    args.realm,
    NODES_API
  );
  return {
    type: args.type,
    required: res.required ?? [],
    properties: res.properties ?? {},
  };
}

export const listAllNodesInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

/**
 * List every node in the realm across all types. AM's per-type _queryFilter
 * endpoints only return nodes of one type; ?_action=nextdescendents returns
 * all of them. Useful for finding orphans, auditing the realm, or discovering
 * nodes referenced by trees you don't know about.
 */
export async function listAllNodes(
  am: AmClient,
  args: z.infer<typeof listAllNodesInput>
): Promise<{ count: number; nodes: { id: string; type: string }[] }> {
  const res = await am.realmPost(
    `${NODES_PATH}?_action=nextdescendents`,
    {},
    args.realm,
    NODES_API
  );
  const nodes = (res.result ?? []).map((n: any) => ({
    id: n._id,
    type: n._type?._id ?? "unknown",
  }));
  return { count: nodes.length, nodes };
}

export const listNodesInput = z.object({
  type: z.string().describe("Node type id to list, e.g. 'UsernameCollectorNode'."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function listNodes(
  am: AmClient,
  args: z.infer<typeof listNodesInput>
): Promise<{ type: string; count: number; nodes: { id: string }[] }> {
  const res = await am.realmGet(
    `${NODES_PATH}/${encodeURIComponent(args.type)}?_queryFilter=true`,
    args.realm,
    NODES_API
  );
  return {
    type: args.type,
    count: res.resultCount ?? 0,
    nodes: (res.result ?? []).map((n: any) => ({ id: n._id })),
  };
}

export const getNodeInput = z.object({
  type: z.string().describe("Node type id (must match the node's actual type)."),
  id: z.string().describe("Node UUID."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function getNode(
  am: AmClient,
  args: z.infer<typeof getNodeInput>
): Promise<unknown> {
  return am.realmGet(
    `${NODES_PATH}/${encodeURIComponent(args.type)}/${encodeURIComponent(args.id)}`,
    args.realm,
    NODES_API
  );
}

export const upsertNodeInput = z.object({
  type: z.string().describe("Node type id, e.g. 'UsernameCollectorNode'."),
  id: z
    .string()
    .optional()
    .describe(
      "Node UUID. If omitted, AM generates one (create-only mode). Supply a UUID to control the id (useful when wiring into a tree's nodes map)."
    ),
  config: z
    .record(z.unknown())
    .optional()
    .describe(
      "Node-type-specific configuration object. Use get_node_type_schema to discover required fields. Defaults to empty (valid for nodes like UsernameCollectorNode or DataStoreDecisionNode that take no config)."
    ),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

/**
 * Create or update a node. Two paths:
 *   - id supplied → PUT to /nodes/{type}/{id}; AM upserts.
 *   - id omitted  → POST ?_action=create; AM generates a UUID.
 * Returns { id, type } in both cases.
 */
export async function upsertNode(
  am: AmClient,
  args: z.infer<typeof upsertNodeInput>
): Promise<{ id: string; type: string }> {
  const body = args.config ?? {};
  if (args.id) {
    const res = await am.realmPut(
      `${NODES_PATH}/${encodeURIComponent(args.type)}/${encodeURIComponent(args.id)}`,
      body,
      args.realm,
      NODES_API
    );
    return { id: res._id ?? args.id, type: args.type };
  }
  const res = await am.realmPost(
    `${NODES_PATH}/${encodeURIComponent(args.type)}?_action=create`,
    body,
    args.realm,
    NODES_API
  );
  return { id: res._id, type: args.type };
}

export const deleteNodeInput = z.object({
  type: z.string().describe("Node type id."),
  id: z.string().describe("Node UUID."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function deleteNode(
  am: AmClient,
  args: z.infer<typeof deleteNodeInput>
): Promise<{ deleted: { id: string; type: string; realm: string } }> {
  try {
    await am.realmDelete(
      `${NODES_PATH}/${encodeURIComponent(args.type)}/${encodeURIComponent(args.id)}`,
      args.realm,
      NODES_API
    );
  } catch (err) {
    if (err instanceof AmError && err.status === 404) {
      throw new Error(`Node ${args.type}/${args.id} not found`);
    }
    throw err;
  }
  return {
    deleted: { id: args.id, type: args.type, realm: args.realm ?? "(server default)" },
  };
}
