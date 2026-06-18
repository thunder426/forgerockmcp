#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./jsonSchema.js";
import { loadConfig, loadEnv } from "./config.js";
import { AmClient, AmError } from "./am/client.js";
import { IdmError } from "./idm/client.js";
import { IdmClient } from "./idm/client.js";
import {
  AuthError,
  loadAuthenticator,
  type AuthIdentity,
  type Permission,
} from "./auth.js";
import { createToolLogger, redactArgs } from "./logger.js";
import {
  createJourney,
  createJourneyInput,
  deleteJourney,
  deleteJourneyInput,
  editJourneyEdges,
  editJourneyEdgesInput,
  getJourney,
  getJourneyInput,
  getJourneyTerminals,
  getJourneyTerminalsInput,
  listJourneys,
  listJourneysInput,
  updateJourney,
  updateJourneyInput,
} from "./tools/journeys.js";
import {
  deleteNode,
  deleteNodeInput,
  getNode,
  getNodeInput,
  getNodeTypeSchema,
  getNodeTypeSchemaInput,
  listAllNodes,
  listAllNodesInput,
  listNodeTypes,
  listNodeTypesInput,
  listNodes,
  listNodesInput,
  upsertNode,
  upsertNodeInput,
} from "./tools/nodes.js";
import {
  createRealm,
  createRealmInput,
  deleteRealm,
  deleteRealmInput,
  listRealms,
  listRealmsInput,
} from "./tools/realms.js";
import {
  configureIdentityStore,
  configureIdentityStoreInput,
  deleteIdentityStore,
  deleteIdentityStoreInput,
  listIdentityStores,
  listIdentityStoresInput,
  listIdentityStoreTypes,
  listIdentityStoreTypesInput,
} from "./tools/identityStores.js";
import {
  createUser,
  createUserInput,
  deleteUser,
  deleteUserInput,
  getUser,
  getUserInput,
  listUsers,
  listUsersInput,
  updateUser,
  updateUserInput,
} from "./tools/users.js";
import {
  deleteScript,
  deleteScriptInput,
  getScript,
  getScriptInput,
  listScriptContexts,
  listScriptContextsInput,
  listScripts,
  listScriptsInput,
  upsertScript,
  upsertScriptInput,
} from "./tools/scripts.js";

const env = loadEnv();
const cfg = loadConfig(env);
// Authenticator reads from the same merged env (process.env + mcp-server/env/.env).
// This is safe because the server's dotenv belongs to the server side — only the
// server reads it. The agent's dotenv (agent/env/.env) is in a different folder
// and never loaded. Cross-folder isolation is enforced in config.ts's loadDotenv.
const authenticator = loadAuthenticator(env);
// Audit log of every tool call the agent makes (JSONL file + stderr mirror).
const toolLogger = createToolLogger(env);
const am = new AmClient({
  baseUrl: cfg.amBaseUrl,
  realm: cfg.amRealm,
  adminUser: cfg.amAdminUser,
  adminPassword: cfg.amAdminPassword,
  insecureTls: cfg.amInsecureTls,
});
// IDM uses an OAuth2 bearer minted as amadmin via idm-admin-ui (public client).
// IDM's staticUserMapping for sub=amadmin maps that bearer to openidm-admin.
// We reuse the same AM admin credentials — no separate IDM config needed.
const idm = new IdmClient({
  baseUrl: cfg.amBaseUrl,
  adminUser: cfg.amAdminUser,
  adminPassword: cfg.amAdminPassword,
  insecureTls: cfg.amInsecureTls,
});

const tools = [
  {
    name: "list_journeys",
    permission: "read",
    description:
      "List authentication journeys (trees) in a ForgeRock AM realm. Returns each journey's id, description, and enabled status.",
    inputSchema: zodToJsonSchema(listJourneysInput),
    handler: (args: unknown) => listJourneys(am, listJourneysInput.parse(args)),
  },
  {
    name: "get_journey",
    permission: "read",
    description:
      "Get the full configuration of a single authentication journey, including all nodes, outcomes, entry point, and UI config.",
    inputSchema: zodToJsonSchema(getJourneyInput),
    handler: (args: unknown) => getJourney(am, getJourneyInput.parse(args)),
  },
  {
    name: "get_journey_terminals",
    permission: "read",
    description:
      "Returns the AM-wide success and failure node UUIDs to use as terminal targets in any tree's connections map. Constants — call once and reuse.",
    inputSchema: zodToJsonSchema(getJourneyTerminalsInput),
    handler: () => getJourneyTerminals(),
  },
  {
    name: "create_journey",
    permission: "write",
    description:
      "Create a new authentication journey (tree). Requires entryNodeId (a node UUID) and a 'nodes' map keyed by UUID. Each node references targets via its 'connections' map; use get_journey_terminals for terminal UUIDs. Fails if a journey with the same id exists.",
    inputSchema: zodToJsonSchema(createJourneyInput),
    handler: (args: unknown) => createJourney(am, createJourneyInput.parse(args)),
  },
  {
    name: "update_journey",
    permission: "write",
    description:
      "Update a journey's description, enabled flag, or entry node. Does NOT change nodes/edges — use edit_journey_edges for that.",
    inputSchema: zodToJsonSchema(updateJourneyInput),
    handler: (args: unknown) => updateJourney(am, updateJourneyInput.parse(args)),
  },
  {
    name: "delete_journey",
    permission: "delete",
    description:
      "Delete a journey. Cascades to its referenced nodes (AM 8 behavior — observed: nodes referenced only by the deleted tree go away too). To preserve a node, remove its tree reference via edit_journey_edges first.",
    inputSchema: zodToJsonSchema(deleteJourneyInput),
    handler: (args: unknown) => deleteJourney(am, deleteJourneyInput.parse(args)),
  },
  {
    name: "edit_journey_edges",
    permission: "write",
    description:
      "Rewire a journey: replace connections on listed nodes, optionally add/remove entries from the tree's nodes map. The 'edges' map is keyed by source node id; its inner map is { outcome → target node id }. AM's tree PUT is full-replace, so this tool reads the current tree, applies the diff, and writes it back.",
    inputSchema: zodToJsonSchema(editJourneyEdgesInput),
    handler: (args: unknown) => editJourneyEdges(am, editJourneyEdgesInput.parse(args)),
  },
  {
    name: "list_node_types",
    permission: "read",
    description:
      "List every authentication node type AM supports (~140). Each result has an id (use as the 'type' arg for other node tools), a human name, tags, and help text.",
    inputSchema: zodToJsonSchema(listNodeTypesInput),
    handler: (args: unknown) => listNodeTypes(am, listNodeTypesInput.parse(args)),
  },
  {
    name: "get_node_type_schema",
    permission: "read",
    description:
      "Get the JSON schema for a node type's config. Use this before upsert_node to discover required fields. Zero-config types (UsernameCollectorNode, DataStoreDecisionNode, etc) return an empty properties object.",
    inputSchema: zodToJsonSchema(getNodeTypeSchemaInput),
    handler: (args: unknown) => getNodeTypeSchema(am, getNodeTypeSchemaInput.parse(args)),
  },
  {
    name: "list_nodes",
    permission: "read",
    description:
      "List every existing node of a given type in the realm. Useful for finding orphans or pre-existing reusable nodes.",
    inputSchema: zodToJsonSchema(listNodesInput),
    handler: (args: unknown) => listNodes(am, listNodesInput.parse(args)),
  },
  {
    name: "list_all_nodes",
    permission: "read",
    description:
      "List every node in the realm across ALL types. Returns each node's id and type. Use this when you want to audit the realm or find nodes whose type you don't know in advance — list_nodes only returns one type at a time.",
    inputSchema: zodToJsonSchema(listAllNodesInput),
    handler: (args: unknown) => listAllNodes(am, listAllNodesInput.parse(args)),
  },
  {
    name: "get_node",
    permission: "read",
    description: "Get a single node's config by type + UUID.",
    inputSchema: zodToJsonSchema(getNodeInput),
    handler: (args: unknown) => getNode(am, getNodeInput.parse(args)),
  },
  {
    name: "upsert_node",
    permission: "write",
    description:
      "Create or replace a node. Supply 'id' to control the UUID (needed when wiring into a tree); omit it to let AM generate one. 'config' is the node-type-specific body; check get_node_type_schema for required fields.",
    inputSchema: zodToJsonSchema(upsertNodeInput),
    handler: (args: unknown) => upsertNode(am, upsertNodeInput.parse(args)),
  },
  {
    name: "delete_node",
    permission: "delete",
    description: "Delete a node by type + UUID. Doesn't touch any tree that references it; remove edges first via edit_journey_edges.",
    inputSchema: zodToJsonSchema(deleteNodeInput),
    handler: (args: unknown) => deleteNode(am, deleteNodeInput.parse(args)),
  },
  {
    name: "list_realms",
    permission: "read",
    description:
      "List all realms configured in AM. Includes the realm id, name, parent path, active status, and DNS aliases.",
    inputSchema: zodToJsonSchema(listRealmsInput),
    handler: () => listRealms(am),
  },
  {
    name: "create_realm",
    permission: "write",
    description:
      "Create a new realm under a parent path. Returns the new realm's id (base64 of its full path), name, parent, and active flag.",
    inputSchema: zodToJsonSchema(createRealmInput),
    handler: (args: unknown) => createRealm(am, createRealmInput.parse(args)),
  },
  {
    name: "delete_realm",
    permission: "delete",
    description:
      "Delete a realm by name (preferred) or by id. Resolves name → id via list_realms when needed; fails if the name is ambiguous.",
    inputSchema: zodToJsonSchema(deleteRealmInput),
    handler: (args: unknown) => deleteRealm(am, deleteRealmInput.parse(args)),
  },
  {
    name: "list_identity_store_types",
    permission: "read",
    description:
      "List the LDAP identity store types AM supports for a realm (e.g. LDAPv3ForOpenDS, LDAPv3ForAD). Use these as the 'type' field for configure_identity_store and list_identity_stores.",
    inputSchema: zodToJsonSchema(listIdentityStoreTypesInput),
    handler: (args: unknown) =>
      listIdentityStoreTypes(am, listIdentityStoreTypesInput.parse(args)),
  },
  {
    name: "list_identity_stores",
    permission: "read",
    description:
      "List all identity stores in a realm, across every type. Returns each store's id, type, baseDN, servers, and connection mode. Use this before configure_identity_store to avoid creating a duplicate.",
    inputSchema: zodToJsonSchema(listIdentityStoresInput),
    handler: (args: unknown) =>
      listIdentityStores(am, listIdentityStoresInput.parse(args)),
  },
  {
    name: "configure_identity_store",
    permission: "write",
    description:
      "Create an LDAP identity store on a realm. Fetches AM's template for the chosen type and overlays the supplied host/baseDN/bind credentials. For local dev against ds-idrepo, use type=LDAPv3ForOpenDS, host='ds-idrepo-0.ds-idrepo:1389', connectionMode='LDAP'.",
    inputSchema: zodToJsonSchema(configureIdentityStoreInput),
    handler: (args: unknown) =>
      configureIdentityStore(am, configureIdentityStoreInput.parse(args)),
  },
  {
    name: "delete_identity_store",
    permission: "delete",
    description: "Delete an identity store from a realm.",
    inputSchema: zodToJsonSchema(deleteIdentityStoreInput),
    handler: (args: unknown) =>
      deleteIdentityStore(am, deleteIdentityStoreInput.parse(args)),
  },
  {
    name: "list_users",
    permission: "read",
    description:
      "List users in a realm. Returns id, uid, mail, cn, sn, givenName, active. Supports CREST query filters and pagination.",
    inputSchema: zodToJsonSchema(listUsersInput),
    handler: (args: unknown) => listUsers(am, listUsersInput.parse(args)),
  },
  {
    name: "get_user",
    permission: "read",
    description:
      "Get a single user by uid (the human-readable login). Pass raw=true for the full multi-valued AM record.",
    inputSchema: zodToJsonSchema(getUserInput),
    handler: (args: unknown) => getUser(am, getUserInput.parse(args)),
  },
  {
    name: "create_user",
    permission: "write",
    description:
      "Create a user via IDM's managed/user. Required: uid, password, sn, givenName, mail (IDM policy). Realm-global — the same user is visible to AM auth in any realm. AM-created users are invisible to IDM's managed/user queries and break the /openidm/* bearer flow, which is why this tool goes through IDM.",
    inputSchema: zodToJsonSchema(createUserInput),
    handler: (args: unknown) => createUser(idm, createUserInput.parse(args)),
  },
  {
    name: "update_user",
    permission: "write",
    description:
      "Update an IDM-managed user by uid (userName). Supports partial updates without rotating the password. Only manages users created via create_user (or otherwise visible to IDM managed/user) — pre-existing AM-only users are not visible here.",
    inputSchema: zodToJsonSchema(updateUserInput),
    handler: (args: unknown) => updateUser(idm, updateUserInput.parse(args)),
  },
  {
    name: "delete_user",
    permission: "delete",
    description:
      "Delete an IDM-managed user by uid (userName). Only manages users visible to IDM managed/user.",
    inputSchema: zodToJsonSchema(deleteUserInput),
    handler: (args: unknown) => deleteUser(idm, deleteUserInput.parse(args)),
  },
  {
    name: "list_scripts",
    permission: "read",
    description:
      "List AM scripts in a realm. Each entry has id, name, language (JAVASCRIPT/GROOVY), context (where AM uses it). Pass context to filter — e.g. context='SCRIPTED_DECISION_NODE' returns only scripts usable by ScriptedDecisionNode in journeys.",
    inputSchema: zodToJsonSchema(listScriptsInput),
    handler: (args: unknown) => listScripts(am, listScriptsInput.parse(args)),
  },
  {
    name: "get_script",
    permission: "read",
    description:
      "Get a script by id. Returns metadata + the decoded source (the wire format is base64; this tool decodes for you). Pass includeSource=false for metadata only.",
    inputSchema: zodToJsonSchema(getScriptInput),
    handler: (args: unknown) => getScript(am, getScriptInput.parse(args)),
  },
  {
    name: "upsert_script",
    permission: "write",
    description:
      "Create or update a script. Pass `source` as plain text (NOT base64 — the tool encodes). Pass `id` to control the UUID; omit to let AM generate one. For ScriptedDecisionNode, use context='SCRIPTED_DECISION_NODE'. NOTE: outcomes are NOT declared on the script — they live on the SDN's config.outcomes; the script must set `outcome = \"<name>\"` to one of those.",
    inputSchema: zodToJsonSchema(upsertScriptInput),
    handler: (args: unknown) => upsertScript(am, upsertScriptInput.parse(args)),
  },
  {
    name: "delete_script",
    permission: "delete",
    description:
      "Delete a script by id. Doesn't check whether any node still references it; check first with list_nodes type=ScriptedDecisionNode and inspect each one's config.script.",
    inputSchema: zodToJsonSchema(deleteScriptInput),
    handler: (args: unknown) => deleteScript(am, deleteScriptInput.parse(args)),
  },
  {
    name: "list_script_contexts",
    permission: "read",
    description:
      "List the well-known AM script contexts (SCRIPTED_DECISION_NODE, OIDC_CLAIMS, etc.) with what each is used for. Use this when picking a 'context' for upsert_script. AM has more contexts than these but these are the common ones.",
    inputSchema: zodToJsonSchema(listScriptContextsInput),
    handler: () => listScriptContexts(),
  },
] as const satisfies readonly {
  name: string;
  permission: Permission;
  description: string;
  inputSchema: object;
  handler: (args: unknown) => Promise<unknown> | unknown;
}[];

/**
 * Build a fresh Server instance with all the tools registered. Each transport
 * connects its own Server instance — for stdio that's one for the process; for
 * HTTP we create one per incoming request (stateless mode), so handlers can't
 * accidentally share per-request state.
 *
 * `headerToken` is the token lifted from the request's `Authorization: Bearer`
 * header (HTTP transport only). It serves as a fallback for callers that can't
 * inject a per-call `_authToken` argument but can set a static connection
 * header — e.g. an MCP host configured with `headers` in its server entry.
 */
function buildServer(transport: "stdio" | "http", headerToken?: string): Server {
  const server = new Server(
    { name: "forgerock-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const startedAt = Date.now();
    const tool = tools.find((t) => t.name === req.params.name);
    // Peel off _authToken so the per-tool zod schemas don't have to know about it.
    // The agent presents the token either as this call arg or, on HTTP, via the
    // Authorization header (captured into headerToken). The call arg wins when
    // both are present.
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const { _authToken, ...handlerArgs } = args;
    const argKeys = Object.keys(handlerArgs);

    if (!tool) {
      toolLogger.record({
        ts: new Date().toISOString(),
        transport,
        tool: req.params.name,
        permission: "unknown",
        status: "unknown_tool",
        durationMs: Date.now() - startedAt,
        argKeys,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    let identity: AuthIdentity | undefined;
    try {
      const callToken =
        (typeof _authToken === "string" ? _authToken : undefined) ?? headerToken;
      identity = await authenticator.authorize(tool.permission, {
        token: callToken,
      });
      const result = await tool.handler(handlerArgs);
      toolLogger.record({
        ts: new Date().toISOString(),
        transport,
        tool: tool.name,
        permission: tool.permission,
        tokenName: identity.name,
        status: "ok",
        durationMs: Date.now() - startedAt,
        argKeys,
        args: redactArgs(handlerArgs),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg =
        err instanceof AuthError
          ? `Auth error: ${err.message}`
          : err instanceof AmError
            ? `AM error ${err.status}: ${JSON.stringify(err.body)}`
            : err instanceof IdmError
              ? `IDM error ${err.status}: ${JSON.stringify(err.body)}`
              : err instanceof Error
                ? err.message
                : String(err);
      // On a privilege-denied error the token was recognized — log which one.
      const tokenName =
        identity?.name ?? (err instanceof AuthError ? err.identity?.name : undefined);
      toolLogger.record({
        ts: new Date().toISOString(),
        transport,
        tool: tool.name,
        permission: tool.permission,
        tokenName,
        status: err instanceof AuthError ? "auth_error" : "error",
        durationMs: Date.now() - startedAt,
        argKeys,
        args: redactArgs(handlerArgs),
        error: msg,
      });
      return {
        isError: true,
        content: [{ type: "text", text: msg }],
      };
    }
  });

  return server;
}

interface CliOptions {
  http: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliOptions {
  let http = false;
  let port = Number(process.env.MCP_HTTP_PORT) || 8765;
  // 127.0.0.1 (not 0.0.0.0) so nothing on the LAN can reach this dev server.
  // The SDK's createMcpExpressApp adds DNS-rebinding protection automatically
  // when host is a localhost address.
  let host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") http = true;
    else if (arg === "--port") port = Number(argv[++i]);
    else if (arg === "--host") host = argv[++i];
    else if (arg === "--help") {
      process.stderr.write(
        "Usage: forgerock-mcp [--http] [--port N] [--host H]\n" +
          "  default: stdio transport (spawned by an MCP host)\n" +
          "  --http : HTTP transport bound to 127.0.0.1:8765\n"
      );
      process.exit(0);
    }
  }
  return { http, port, host };
}

async function runStdio(): Promise<void> {
  const server = buildServer("stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `forgerock-mcp v0.1.0 ready (stdio); AM=${cfg.amBaseUrl} realm=${cfg.amRealm} user=${cfg.amAdminUser} auth=${authenticator.modeName()} log=${toolLogger.filePath ?? "stderr-only"}`
  );
}

async function runHttp(opts: CliOptions): Promise<void> {
  // Lazy-imported so stdio mode doesn't pay the express startup cost.
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { createMcpExpressApp } = await import(
    "@modelcontextprotocol/sdk/server/express.js"
  );

  const app = createMcpExpressApp({ host: opts.host });

  // Stateless: a fresh Server + transport per request. Simplest for our model
  // — the agent passes _authToken on every call, so we don't need the SDK's
  // sticky-session story. Easier to reason about; trivially horizontally
  // scalable later.
  app.post("/mcp", async (req, res) => {
    // Lift a bearer token off the connection header so an MCP host can supply
    // the secret via static `headers` config instead of a per-call argument.
    // Falls through to the call-arg `_authToken` path when absent.
    const authHeader = req.headers.authorization;
    const headerToken =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : undefined;
    const server = buildServer("http", headerToken);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("HTTP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /mcp would be for SSE streaming; we don't expose long-lived streams,
  // so reject explicitly so a misconfigured client gets a clear error.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "GET not supported (stateless mode)" },
      id: null,
    });
  });

  app.listen(opts.port, opts.host, () => {
    console.error(
      `forgerock-mcp v0.1.0 ready (http://${opts.host}:${opts.port}/mcp); AM=${cfg.amBaseUrl} realm=${cfg.amRealm} user=${cfg.amAdminUser} auth=${authenticator.modeName()} log=${toolLogger.filePath ?? "stderr-only"}`
    );
  });
}

const opts = parseArgs(process.argv.slice(2));
if (opts.http) {
  await runHttp(opts);
} else {
  await runStdio();
}
