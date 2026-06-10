import { z } from "zod";
import { AmClient } from "../am/client.js";

const ID_REPO_API = "protocol=2.1, resource=1.0";

/**
 * AM identity-store types as returned by `?_action=getAllTypes`. We expose them
 * as an enum so the LLM picks a real value rather than a freeform string.
 */
const IDENTITY_STORE_TYPES = [
  "LDAPv3ForOpenDS",
  "LDAPv3ForForgeRockIAM",
  "LDAPv3ForAMDS",
  "LDAPv3ForAD",
  "LDAPv3ForADAM",
  "LDAPv3ForTivoli",
  "LDAPv3ForPingDirectory",
  "LDAPv3",
] as const;

export const listIdentityStoreTypesInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

export async function listIdentityStoreTypes(
  am: AmClient,
  args: z.infer<typeof listIdentityStoreTypesInput>
): Promise<{ types: { id: string; name: string }[] }> {
  const res = await am.realmPost(
    "/realm-config/services/id-repositories?_action=getAllTypes",
    {},
    args.realm,
    ID_REPO_API
  );
  return {
    types: (res.result ?? []).map((t: any) => ({ id: t._id, name: t.name })),
  };
}

export const listIdentityStoresInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
});

/**
 * AM's REST keys id-repositories by *type* in the URL, which means
 * `_queryFilter=true` on a type-scoped path returns only stores of that type and
 * silently hides others — exactly the bug that misled us into provisioning a
 * second store next to forgeops's auto-provisioned one. `?_action=nextdescendents`
 * is what the AM admin console uses and returns every store with its real type.
 */
export async function listIdentityStores(
  am: AmClient,
  args: z.infer<typeof listIdentityStoresInput>
): Promise<{
  count: number;
  stores: { id: string; type: string; typeName: string; baseDN: string | null; servers: string[]; connectionMode: string | null }[];
}> {
  const res = await am.realmPost(
    "/realm-config/services/id-repositories?_action=nextdescendents",
    {},
    args.realm,
    ID_REPO_API
  );
  const stores = (res.result ?? []).map((s: any) => ({
    id: s._id,
    type: s._type?._id ?? "unknown",
    typeName: s._type?.name ?? "unknown",
    baseDN: s.ldapsettings?.["sun-idrepo-ldapv3-config-organization_name"] ?? null,
    servers: s.ldapsettings?.["sun-idrepo-ldapv3-config-ldap-server"] ?? [],
    connectionMode: s.ldapsettings?.["sun-idrepo-ldapv3-config-connection-mode"] ?? null,
  }));
  return { count: stores.length, stores };
}

export const configureIdentityStoreInput = z.object({
  realm: z
    .string()
    .describe("Realm to attach the identity store to. The realm must already exist."),
  name: z
    .string()
    .describe(
      "Identity store name (becomes its _id), e.g. 'idrepo'. Avoid 'OpenDJ' — AM treats it as reserved on the forgeops overlay and rejects creation with 409."
    ),
  type: z
    .enum(IDENTITY_STORE_TYPES)
    .optional()
    .describe("AM identity store type. Defaults to LDAPv3ForOpenDS (matches forgeops DS)."),
  host: z
    .string()
    .describe("DS host:port pair, e.g. 'ds-idrepo-0.ds-idrepo:1389'. Pass multiple via 'extraHosts'."),
  extraHosts: z
    .array(z.string())
    .optional()
    .describe("Additional DS host:port pairs for failover."),
  baseDN: z
    .string()
    .describe("Search base DN for users, e.g. 'ou=identities' or 'o=alpha,o=root,ou=identities'."),
  bindDN: z.string().describe("Bind DN, e.g. 'uid=am-identity-bind-account,ou=admins,ou=identities'."),
  bindPassword: z.string().describe("Bind password."),
  connectionMode: z
    .enum(["LDAP", "LDAPS", "StartTLS"])
    .optional()
    .describe("Connection mode. Defaults to 'LDAP' to match the in-cluster ds-idrepo service."),
  trustAllCerts: z
    .boolean()
    .optional()
    .describe("If true, accept any DS TLS cert. Useful for self-signed dev DS."),
  overrides: z
    .record(z.unknown())
    .optional()
    .describe(
      "Advanced: deep-merge into the AM template. Top-level keys are template sections (ldapsettings, userconfig, groupconfig, ...)."
    ),
});

/**
 * Create an LDAP identity store on a realm.
 *
 * AM keys id-repositories by type, so the create URL embeds the type. We fetch
 * AM's own template for that type, then layer the user's settings on top — this
 * keeps us forward-compatible with any new fields AM adds (we don't enumerate
 * the full sun-idrepo-ldapv3-config-* surface).
 */
export async function configureIdentityStore(
  am: AmClient,
  args: z.infer<typeof configureIdentityStoreInput>
): Promise<{ id: string; realm: string; type: string }> {
  const type = args.type ?? "LDAPv3ForOpenDS";
  const template = await am.realmPost(
    `/realm-config/services/id-repositories/${encodeURIComponent(type)}?_action=template`,
    {},
    args.realm,
    ID_REPO_API
  );

  const servers = [args.host, ...(args.extraHosts ?? [])];
  const ldapsettings = {
    ...(template.ldapsettings ?? {}),
    "sun-idrepo-ldapv3-config-ldap-server": servers,
    "sun-idrepo-ldapv3-config-organization_name": args.baseDN,
    "sun-idrepo-ldapv3-config-authid": args.bindDN,
    "sun-idrepo-ldapv3-config-authpw": args.bindPassword,
    "sun-idrepo-ldapv3-config-connection-mode": args.connectionMode ?? "LDAP",
    ...(args.trustAllCerts !== undefined
      ? { "sun-idrepo-ldapv3-config-trust-all-server-certificates": args.trustAllCerts }
      : {}),
  };
  const persistentsearch = {
    ...(template.persistentsearch ?? {}),
    "sun-idrepo-ldapv3-config-psearchbase": args.baseDN,
  };

  const body: Record<string, unknown> = {
    ...template,
    ldapsettings,
    persistentsearch,
    _id: args.name,
  };

  if (args.overrides) {
    for (const [section, value] of Object.entries(args.overrides)) {
      const existing = body[section];
      body[section] =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
          : value;
    }
  }

  const res = await am.realmPost(
    `/realm-config/services/id-repositories/${encodeURIComponent(type)}?_action=create`,
    body,
    args.realm,
    ID_REPO_API
  );
  return { id: res._id ?? args.name, realm: args.realm, type };
}

export const deleteIdentityStoreInput = z.object({
  realm: z.string().describe("Realm the identity store lives in."),
  type: z.enum(IDENTITY_STORE_TYPES).describe("Identity store type."),
  name: z.string().describe("Identity store name (its _id)."),
});

export async function deleteIdentityStore(
  am: AmClient,
  args: z.infer<typeof deleteIdentityStoreInput>
): Promise<{ deleted: { realm: string; type: string; name: string } }> {
  await am.realmDelete(
    `/realm-config/services/id-repositories/${encodeURIComponent(args.type)}/${encodeURIComponent(args.name)}`,
    args.realm,
    ID_REPO_API
  );
  return { deleted: { realm: args.realm, type: args.type, name: args.name } };
}
