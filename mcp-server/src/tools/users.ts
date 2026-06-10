import { z } from "zod";
import { AmClient, AmError } from "../am/client.js";
import { IdmClient, IdmError } from "../idm/client.js";

const USERS_API = "protocol=2.1, resource=4.0";

/**
 * AM stores user attributes as multi-valued LDAP arrays. We collapse single-element
 * arrays to scalars in the projected summary so the LLM doesn't have to think about it,
 * but the underlying record keeps array shape for round-tripping.
 *
 * IDM returns scalars directly, so summarize() handles both shapes via pickFirst().
 */
type UserSummary = {
  id: string;
  uid: string;
  mail?: string;
  cn?: string;
  sn?: string;
  givenName?: string;
  active?: boolean;
};

function pickFirst(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

function summarize(raw: any): UserSummary {
  const status = pickFirst(raw.inetUserStatus) ?? pickFirst(raw.accountStatus);
  return {
    id: raw._id,
    uid: pickFirst(raw.userName) ?? pickFirst(raw.uid) ?? raw._id,
    mail: pickFirst(raw.mail),
    cn: pickFirst(raw.cn),
    sn: pickFirst(raw.sn),
    givenName: pickFirst(raw.givenName),
    active: status === undefined ? undefined : status.toLowerCase() === "active",
  };
}

/** Resolve a uid to AM's internal _id via _queryFilter. uid must be unique within a realm. */
async function resolveUidInAm(am: AmClient, uid: string, realm?: string): Promise<string> {
  const res = await am.realmGet(
    `/users?_queryFilter=${encodeURIComponent(`uid eq "${uid}"`)}&_fields=_id`,
    realm,
    USERS_API
  );
  const result = res.result ?? [];
  if (result.length === 0) throw new Error(`No user with uid='${uid}' in realm '${realm ?? "(default)"}'`);
  if (result.length > 1) throw new Error(`Multiple users with uid='${uid}' (data integrity bug — uid should be unique)`);
  return result[0]._id;
}

/**
 * Resolve a userName to IDM's _id via managed/user _queryFilter. userName is
 * unique across the managed/user collection.
 *
 * IDM-created users are queryable here; AM-created users are not (see
 * project memory: am-created-users-invisible-to-idm-query). If you get
 * "No user" here for a uid that exists in AM, that user predates the IDM
 * create path and IDM has no record of it.
 */
async function resolveUidInIdm(idm: IdmClient, uid: string): Promise<string> {
  const res = await idm.get(
    `/managed/user?_queryFilter=${encodeURIComponent(`userName eq "${uid}"`)}&_fields=_id`
  );
  const result = res.result ?? [];
  if (result.length === 0) {
    throw new Error(
      `No IDM-managed user with userName='${uid}'. (AM-created users are not visible to IDM; this tool only manages users created via IDM.)`
    );
  }
  if (result.length > 1) {
    throw new Error(`Multiple users with userName='${uid}' (data integrity bug — userName should be unique)`);
  }
  return result[0]._id;
}

export const listUsersInput = z.object({
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  filter: z
    .string()
    .optional()
    .describe(
      "Optional CREST query filter, e.g. 'uid sw \"mcp-\"' or 'mail co \"@local.test\"'. Defaults to listing all users."
    ),
  pageSize: z
    .number()
    .optional()
    .describe("Max users to return per page. Defaults to 100."),
  pagedResultsCookie: z
    .string()
    .optional()
    .describe("Opaque cursor returned by a previous call to fetch the next page."),
});

export async function listUsers(
  am: AmClient,
  args: z.infer<typeof listUsersInput>
): Promise<{
  realm: string;
  count: number;
  pagedResultsCookie: string | null;
  users: UserSummary[];
}> {
  const filter = args.filter ?? "true";
  const params = new URLSearchParams({
    _queryFilter: filter,
    _pageSize: String(args.pageSize ?? 100),
  });
  if (args.pagedResultsCookie) params.set("_pagedResultsCookie", args.pagedResultsCookie);
  const res = await am.realmGet(`/users?${params.toString()}`, args.realm, USERS_API);
  return {
    realm: args.realm ?? "(server default)",
    count: res.resultCount ?? 0,
    pagedResultsCookie: res.pagedResultsCookie ?? null,
    users: (res.result ?? []).map(summarize),
  };
}

export const getUserInput = z.object({
  uid: z.string().describe("User uid (the human-readable login, e.g. 'mcp-admin')."),
  realm: z.string().optional().describe("Realm. Defaults to the server's configured realm."),
  raw: z
    .boolean()
    .optional()
    .describe("If true, return the full AM record (multi-valued arrays, all attributes). Defaults to a summary."),
});

export async function getUser(
  am: AmClient,
  args: z.infer<typeof getUserInput>
): Promise<UserSummary | unknown> {
  const id = await resolveUidInAm(am, args.uid, args.realm);
  const raw = await am.realmGet(`/users/${encodeURIComponent(id)}`, args.realm, USERS_API);
  return args.raw ? raw : summarize(raw);
}

export const createUserInput = z.object({
  uid: z
    .string()
    .describe(
      "User uid (becomes IDM managed/user.userName and the AM login). IDM managed/user is realm-global; the same user is visible to AM auth in any realm."
    ),
  password: z
    .string()
    .describe("Initial password. Must satisfy IDM's password policy (≥8 chars, mixed case, digit, symbol)."),
  sn: z.string().describe("Surname. Required by IDM managed/user policy."),
  givenName: z.string().describe("Given (first) name. Required by IDM managed/user policy."),
  mail: z.string().describe("Email address. Required by IDM managed/user policy."),
  cn: z.string().optional().describe("Common name. Defaults to '<givenName> <sn>' if omitted."),
});

/**
 * Create a user via IDM's managed/user. The user lands in the same DS container
 * AM reads from (`ou=people,ou=identities`), so AM can authenticate them after.
 *
 * Why not AM's /users endpoint? AM-created users are invisible to IDM's
 * managed/user _queryFilter — the rsFilter can't build a SecurityContext for
 * them, and any /openidm/* call with their bearer 503s. See project memory:
 * am-created-users-invisible-to-idm-query.
 */
export async function createUser(
  idm: IdmClient,
  args: z.infer<typeof createUserInput>
): Promise<UserSummary> {
  const body: Record<string, unknown> = {
    userName: args.uid,
    password: args.password,
    sn: args.sn,
    givenName: args.givenName,
    mail: args.mail,
    cn: args.cn ?? `${args.givenName} ${args.sn}`,
  };
  const res = await idm.post(`/managed/user?_action=create`, body);
  return summarize(res);
}

export const updateUserInput = z.object({
  uid: z.string().describe("User uid (userName) to update."),
  password: z.string().optional().describe("New password. Omit to leave unchanged."),
  sn: z.string().optional().describe("New surname. Omit to leave unchanged."),
  cn: z.string().optional().describe("New common name. Omit to leave unchanged."),
  givenName: z.string().optional().describe("New given (first) name. Omit to leave unchanged."),
  mail: z.string().optional().describe("New email address. Omit to leave unchanged."),
  active: z
    .boolean()
    .optional()
    .describe("Set accountStatus to 'active' (true) or 'inactive' (false). Omit to leave unchanged."),
});

/**
 * Update a user via IDM PATCH on managed/user. Unlike AM's /users PUT, IDM
 * supports partial field updates without rotating the password.
 */
export async function updateUser(
  idm: IdmClient,
  args: z.infer<typeof updateUserInput>
): Promise<UserSummary> {
  const id = await resolveUidInIdm(idm, args.uid);
  const ops: Array<{ operation: string; field: string; value: unknown }> = [];
  if (args.password !== undefined) ops.push({ operation: "replace", field: "/password", value: args.password });
  if (args.sn !== undefined) ops.push({ operation: "replace", field: "/sn", value: args.sn });
  if (args.cn !== undefined) ops.push({ operation: "replace", field: "/cn", value: args.cn });
  if (args.givenName !== undefined) ops.push({ operation: "replace", field: "/givenName", value: args.givenName });
  if (args.mail !== undefined) ops.push({ operation: "replace", field: "/mail", value: args.mail });
  if (args.active !== undefined) {
    ops.push({ operation: "replace", field: "/accountStatus", value: args.active ? "active" : "inactive" });
  }
  if (ops.length === 0) {
    throw new Error("update_user called with no fields to change");
  }
  const res = await idm.patch(`/managed/user/${encodeURIComponent(id)}`, ops);
  return summarize(res);
}

export const deleteUserInput = z.object({
  uid: z.string().describe("User uid (userName) to delete."),
});

export async function deleteUser(
  idm: IdmClient,
  args: z.infer<typeof deleteUserInput>
): Promise<{ deleted: { uid: string; id: string } }> {
  const id = await resolveUidInIdm(idm, args.uid);
  try {
    await idm.delete(`/managed/user/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof IdmError && err.status === 404) {
      throw new Error(`User userName='${args.uid}' (id=${id}) not found in IDM`);
    }
    throw err;
  }
  return { deleted: { uid: args.uid, id } };
}

// Re-export AmError to avoid an unused-import lint when consumers only need it.
export { AmError };
