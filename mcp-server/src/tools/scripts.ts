import { z } from "zod";
import { AmClient, AmError } from "../am/client.js";

/**
 * AM script management.
 *
 * Two AM-side mechanics worth knowing:
 *
 * 1. The `script` field on the wire is base64-encoded. We hide that — the
 *    tools accept and return plain source.
 * 2. Outcome names for ScriptedDecisionNode are NOT declared on the script;
 *    they're declared on the SDN's *config.outcomes* array. Same script can
 *    be reused with different outcome lists. The script is responsible for
 *    setting `outcome = "<one of the declared names>"`.
 *
 * The `context` field categorizes where AM expects the script to be used.
 * For ScriptedDecisionNode you want context="SCRIPTED_DECISION_NODE".
 */

const SCRIPTS_API = "protocol=2.0, resource=1.0";

const SCRIPT_LANGUAGES = ["JAVASCRIPT", "GROOVY"] as const;

/**
 * The well-known AM script contexts. Not exhaustive — AM has more, but these
 * are the ones an authentication-journey-focused agent will encounter. If a
 * user needs a context not listed here, the upsert tool accepts any string.
 */
const COMMON_SCRIPT_CONTEXTS = [
  "SCRIPTED_DECISION_NODE",
  "DEVICE_MATCH_NODE",
  "CONFIG_PROVIDER_NODE",
  "POLICY_CONDITION",
  "OIDC_CLAIMS",
  "OAUTH2_ACCESS_TOKEN_MODIFICATION",
  "OAUTH2_VALIDATE_SCOPE",
  "OAUTH2_EVALUATE_SCOPE",
  "OAUTH2_AUTHORIZE_ENDPOINT_DATA_PROVIDER",
  "OAUTH2_DYNAMIC_CLIENT_REGISTRATION",
  "OAUTH2_MAY_ACT",
  "OAUTH2_SCRIPTED_JWT_ISSUER",
  "SAML2_IDP_ADAPTER",
  "SAML2_IDP_ADAPTER_NEXTGEN",
  "SAML2_IDP_ATTRIBUTE_MAPPER",
  "SAML2_IDP_ATTRIBUTE_MAPPER_NEXT_GEN",
  "SAML2_NAMEID_MAPPER",
  "SAML2_SP_ACCOUNT_MAPPER",
  "SAML2_SP_ADAPTER",
  "SAML2_SP_ADAPTER_NEXTGEN",
  "SOCIAL_IDP_PROFILE_TRANSFORMATION",
  "AUTHENTICATION_CLIENT_SIDE",
  "AUTHENTICATION_SERVER_SIDE",
  "AUTHENTICATION_TREE_DECISION_NODE",
  "LIBRARY",
  "CACHE_LOADER",
] as const;

function decodeSource(s: unknown): string | null {
  if (typeof s !== "string" || s.length === 0) return null;
  return Buffer.from(s, "base64").toString("utf8");
}

function encodeSource(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

type ScriptSummary = {
  id: string;
  name: string;
  context: string;
  language: string;
  description?: string;
  default?: boolean;
};

function summarize(raw: any): ScriptSummary {
  return {
    id: raw._id,
    name: raw.name,
    context: raw.context,
    language: raw.language,
    description: raw.description || undefined,
    default: raw.default,
  };
}

export const listScriptsInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  context: z
    .string()
    .optional()
    .describe(
      "Filter by AM script context, e.g. 'SCRIPTED_DECISION_NODE' to find only scripts usable by ScriptedDecisionNode. Omit to list all."
    ),
});

export async function listScripts(
  am: AmClient,
  args: z.infer<typeof listScriptsInput>
): Promise<{ realm: string; count: number; scripts: ScriptSummary[] }> {
  // AM's /scripts supports _queryFilter on context, but a client-side filter
  // keeps the tool's behavior identical regardless of AM-side filter syntax.
  const res = await am.realmGet(
    `/scripts?_queryFilter=true&_pageSize=200`,
    args.realm,
    SCRIPTS_API
  );
  let entries = (res.result ?? []) as any[];
  if (args.context) {
    entries = entries.filter((s: any) => s.context === args.context);
  }
  return {
    realm: args.realm ?? "(server default)",
    count: entries.length,
    scripts: entries.map(summarize),
  };
}

export const getScriptInput = z.object({
  id: z.string().describe("Script id (UUID). Find with list_scripts."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  includeSource: z
    .boolean()
    .optional()
    .describe("If true (default), decode and include the script source. Set false for a metadata-only response."),
});

export async function getScript(
  am: AmClient,
  args: z.infer<typeof getScriptInput>
): Promise<
  ScriptSummary & {
    source: string | null;
    createdBy?: string;
    creationDate?: string;
    lastModifiedBy?: string;
    lastModifiedDate?: string;
    evaluatorVersion?: string;
  }
> {
  const res = await am.realmGet(
    `/scripts/${encodeURIComponent(args.id)}`,
    args.realm,
    SCRIPTS_API
  );
  const includeSource = args.includeSource ?? true;
  return {
    ...summarize(res),
    source: includeSource ? decodeSource(res.script) : null,
    createdBy: res.createdBy,
    creationDate: res.creationDate,
    lastModifiedBy: res.lastModifiedBy,
    lastModifiedDate: res.lastModifiedDate,
    evaluatorVersion: res.evaluatorVersion,
  };
}

export const upsertScriptInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  id: z
    .string()
    .optional()
    .describe(
      "Script UUID. If omitted, AM generates one. Supply when you want to control the id (useful for referencing the script from a ScriptedDecisionNode by id)."
    ),
  name: z.string().describe("Human-readable name shown in the AM scripts list."),
  language: z
    .enum(SCRIPT_LANGUAGES)
    .describe("Script language. JAVASCRIPT covers most use cases; GROOVY is for some legacy contexts."),
  context: z
    .string()
    .describe(
      "Where AM uses this script. For ScriptedDecisionNode use 'SCRIPTED_DECISION_NODE'. See list_scripts for examples."
    ),
  source: z
    .string()
    .describe(
      "Raw script source code (NOT base64). The tool encodes before sending. For SCRIPTED_DECISION_NODE scripts: set the variable `outcome` to one of the names declared on the SDN's config.outcomes."
    ),
  description: z.string().optional(),
});

/**
 * Create or update a script. Always uses PUT — AM's CREST PUT is upsert.
 * Pass `id` to control the UUID; omit for AM to generate one.
 *
 * Important: outcomes are NOT declared here. They live on the
 * ScriptedDecisionNode's `config.outcomes` (an array of {id, displayName}).
 * The script's job is to set `outcome = "<one of those ids>"`.
 */
export async function upsertScript(
  am: AmClient,
  args: z.infer<typeof upsertScriptInput>
): Promise<ScriptSummary> {
  const id = args.id ?? crypto.randomUUID();
  const body = {
    name: args.name,
    language: args.language,
    context: args.context,
    description: args.description ?? "",
    script: encodeSource(args.source),
  };
  const res = await am.realmPut(
    `/scripts/${encodeURIComponent(id)}`,
    body,
    args.realm,
    SCRIPTS_API
  );
  return summarize(res);
}

export const deleteScriptInput = z.object({
  id: z.string().describe("Script id (UUID)."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function deleteScript(
  am: AmClient,
  args: z.infer<typeof deleteScriptInput>
): Promise<{ deleted: { id: string; realm: string } }> {
  try {
    await am.realmDelete(
      `/scripts/${encodeURIComponent(args.id)}`,
      args.realm,
      SCRIPTS_API
    );
  } catch (err) {
    if (err instanceof AmError && err.status === 404) {
      throw new Error(`Script ${args.id} not found`);
    }
    throw err;
  }
  return { deleted: { id: args.id, realm: args.realm ?? "(server default)" } };
}

export const listScriptContextsInput = z.object({});

/**
 * Returns AM's well-known script contexts as a static list. Not from a live
 * AM endpoint (AM's /scripts?_action=getAllTypes returns 501), but observed
 * across the AM 8.1 catalog. Useful for the LLM when picking a context for
 * upsert_script.
 */
export async function listScriptContexts(): Promise<{
  count: number;
  contexts: { id: string; commonUse: string }[];
}> {
  const meanings: Record<string, string> = {
    SCRIPTED_DECISION_NODE: "Used by ScriptedDecisionNode in authentication trees.",
    DEVICE_MATCH_NODE: "Used by DeviceMatchNode for device-fingerprint matching logic.",
    CONFIG_PROVIDER_NODE: "Provides dynamic config to a wrapped node (ConfigProviderNode).",
    POLICY_CONDITION: "Custom AM policy condition.",
    OIDC_CLAIMS: "Customizes OIDC claim values.",
    OAUTH2_ACCESS_TOKEN_MODIFICATION: "Modifies OAuth2 access tokens at issue time.",
    OAUTH2_VALIDATE_SCOPE: "Validates requested OAuth2 scopes.",
    OAUTH2_EVALUATE_SCOPE: "Computes the scopes granted on an OAuth2 request.",
    OAUTH2_AUTHORIZE_ENDPOINT_DATA_PROVIDER: "Adds data to OAuth2 authorize endpoint responses.",
    OAUTH2_DYNAMIC_CLIENT_REGISTRATION: "Customizes OAuth2 dynamic client registration.",
    OAUTH2_MAY_ACT: "OAuth2 token-exchange may_act check.",
    OAUTH2_SCRIPTED_JWT_ISSUER: "Issues custom JWTs for OAuth2 flows.",
    SAML2_IDP_ADAPTER: "SAML2 IdP adapter customization (legacy).",
    SAML2_IDP_ADAPTER_NEXTGEN: "SAML2 IdP adapter customization (next-gen API).",
    SAML2_IDP_ATTRIBUTE_MAPPER: "Maps user attributes to SAML2 assertion attributes (legacy).",
    SAML2_IDP_ATTRIBUTE_MAPPER_NEXT_GEN: "Maps user attributes to SAML2 assertion attributes (next-gen API).",
    SAML2_NAMEID_MAPPER: "Maps a user to a SAML2 NameID.",
    SAML2_SP_ACCOUNT_MAPPER: "Maps a SAML2 assertion subject to a local account.",
    SAML2_SP_ADAPTER: "SAML2 SP adapter customization (legacy).",
    SAML2_SP_ADAPTER_NEXTGEN: "SAML2 SP adapter customization (next-gen API).",
    SOCIAL_IDP_PROFILE_TRANSFORMATION: "Transforms a social-login profile into AM identity attrs.",
    AUTHENTICATION_CLIENT_SIDE: "Legacy AM auth module client-side script.",
    AUTHENTICATION_SERVER_SIDE: "Legacy AM auth module server-side script.",
    AUTHENTICATION_TREE_DECISION_NODE: "Older alias for SCRIPTED_DECISION_NODE — prefer SCRIPTED_DECISION_NODE.",
    LIBRARY: "Reusable script imported by other scripts.",
    CACHE_LOADER: "Custom cache loader for AM internal caches.",
  };
  const contexts = COMMON_SCRIPT_CONTEXTS.map((id) => ({
    id,
    commonUse: meanings[id] ?? "",
  }));
  return { count: contexts.length, contexts };
}
