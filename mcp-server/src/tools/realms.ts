import { z } from "zod";
import { AmClient, AmError } from "../am/client.js";

const REALM_API = "protocol=2.0, resource=1.0";

export const listRealmsInput = z.object({});

export async function listRealms(am: AmClient): Promise<{
  count: number;
  realms: { id: string; name: string; parentPath: string | null; active: boolean; aliases?: string[] }[];
}> {
  const res = await am.globalGet(
    "/json/global-config/realms?_queryFilter=true",
    REALM_API
  );
  return {
    count: res.resultCount ?? 0,
    realms: (res.result ?? []).map((r: any) => ({
      id: r._id,
      name: r.name,
      parentPath: r.parentPath,
      active: r.active,
      aliases: r.aliases,
    })),
  };
}

export const createRealmInput = z.object({
  name: z.string().describe("Realm name to create, e.g. 'alpha'."),
  parentPath: z
    .string()
    .optional()
    .describe("Parent realm path. Defaults to '/'. Use '/alpha' to create a sub-realm of alpha."),
  active: z.boolean().optional().describe("Whether the realm is active. Defaults to true."),
  aliases: z
    .array(z.string())
    .optional()
    .describe("Optional DNS aliases the realm answers to."),
});

export async function createRealm(
  am: AmClient,
  args: z.infer<typeof createRealmInput>
): Promise<{ id: string; name: string; parentPath: string | null; active: boolean; aliases: string[] }> {
  const body = {
    name: args.name,
    parentPath: args.parentPath ?? "/",
    active: args.active ?? true,
    aliases: args.aliases ?? [],
  };
  const res = await am.globalPost(
    "/json/global-config/realms?_action=create",
    body,
    REALM_API
  );
  return {
    id: res._id,
    name: res.name,
    parentPath: res.parentPath,
    active: res.active,
    aliases: res.aliases ?? [],
  };
}

export const deleteRealmInput = z.object({
  name: z
    .string()
    .optional()
    .describe("Realm name (e.g. 'alpha'). One of name or id is required."),
  id: z
    .string()
    .optional()
    .describe("Realm id (the base64-encoded path returned by list_realms). One of name or id is required."),
});

/**
 * Realm IDs are base64(path). The user typically only knows the name, so we
 * resolve via list_realms — that's a single call and the realm count is small.
 */
export async function deleteRealm(
  am: AmClient,
  args: z.infer<typeof deleteRealmInput>
): Promise<{ deleted: { id: string; name: string; parentPath: string | null } }> {
  if (!args.name && !args.id) {
    throw new Error("deleteRealm requires either 'name' or 'id'");
  }
  let id = args.id;
  let name = args.name ?? "";
  let parentPath: string | null = null;
  if (!id) {
    const list = await am.globalGet(
      "/json/global-config/realms?_queryFilter=true",
      REALM_API
    );
    const matches = (list.result ?? []).filter((r: any) => r.name === name);
    if (matches.length === 0) {
      throw new Error(`No realm named '${name}'`);
    }
    if (matches.length > 1) {
      const paths = matches.map((m: any) => m.parentPath).join(", ");
      throw new Error(
        `Multiple realms named '${name}' under different parents (${paths}); pass 'id' instead`
      );
    }
    id = matches[0]._id;
    parentPath = matches[0].parentPath;
  }
  try {
    const res = await am.globalDelete(
      `/json/global-config/realms/${id}`,
      REALM_API
    );
    return {
      deleted: {
        id: res._id ?? id!,
        name: res.name ?? name,
        parentPath: res.parentPath ?? parentPath,
      },
    };
  } catch (err) {
    if (err instanceof AmError && err.status === 404) {
      throw new Error(`Realm not found (id=${id})`);
    }
    throw err;
  }
}
