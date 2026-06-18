/**
 * MCP-side authentication.
 *
 * Architecture: server and agent are separate. Each holds the shared secret
 * independently — the server from its tokens file, the agent from its host
 * config. They never share a filesystem; the token only travels per-call, as
 * the `_authToken` argument or an `Authorization: Bearer` header.
 *
 * Modes:
 *   - static (local/dev): server validates each call's token against the set
 *     of issued tokens in the tokens file with a constant-time compare.
 *   - oauth-am (prod): each call's token is an OAuth2 bearer the server
 *     introspects against AM and scope-checks. Stubbed below.
 *
 * AM still gets hit with `amadmin` regardless of mode — this gate decides
 * *who is allowed to call the MCP*, not *how the MCP talks to AM*.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Privileges form a hierarchy: read < write < delete. A token granted a higher
 * privilege implicitly holds the lower ones (a `delete` token can also write
 * and read). A tool is tagged with the single privilege it requires; the call
 * is allowed when the token's level is at least that high.
 */
export type Permission = "read" | "write" | "delete";

const RANK: Record<Permission, number> = { read: 1, write: 2, delete: 3 };
const ALL_PERMISSIONS = Object.keys(RANK) as Permission[];

function isPermission(s: string): s is Permission {
  return s === "read" || s === "write" || s === "delete";
}

/** Expand a granted privilege set to everything at or below its highest rank. */
function expandPrivileges(granted: Permission[]): Permission[] {
  const max = Math.max(...granted.map((p) => RANK[p]));
  return ALL_PERMISSIONS.filter((p) => RANK[p] <= max);
}

export interface AuthContext {
  /** The token presented in this call as `_authToken`. Undefined if omitted. */
  token?: string;
}

/** Who a successful authorize() resolved to — flows into the tool-usage log. */
export interface AuthIdentity {
  /** Label of the matched token (from the tokens file), for the audit trail. */
  name: string;
  /** Effective privileges the token holds, after hierarchy expansion. */
  privileges: Permission[];
}

export interface Authenticator {
  /**
   * Resolves to the calling token's identity, or throws AuthError. The error
   * message must include the permission requested.
   */
  authorize(required: Permission, ctx: AuthContext): Promise<AuthIdentity>;
  /** Human-readable mode name for boot logging. */
  modeName(): string;
}

export class AuthError extends Error {
  /** Set when the token was recognized but lacked the required privilege. */
  identity?: AuthIdentity;
  constructor(message: string, identity?: AuthIdentity) {
    super(message);
    this.name = "AuthError";
    this.identity = identity;
  }
}

/** One issued token: a label, the secret bytes, and its effective privileges. */
export interface TokenEntry {
  name: string;
  secret: Buffer;
  /** Highest rank the token holds (read=1, write=2, delete=3). */
  level: number;
  /** Effective privileges after hierarchy expansion (for the audit log). */
  privileges: Permission[];
}

/**
 * Static-secret mode. Validates each call's `_authToken` against a set of
 * issued tokens, each scoped to a privilege level (read < write < delete).
 * A tool tagged `write` accepts any token whose level is write or delete; a
 * `delete` tool accepts only delete tokens; etc.
 *
 * Tokens come from a JSON tokens file (MCP_TOKENS_FILE, default
 * mcp-server/env/tokens.json).
 */
export class StaticSecretAuthenticator implements Authenticator {
  constructor(private readonly tokens: TokenEntry[]) {
    if (tokens.length === 0) {
      throw new Error("StaticSecretAuthenticator requires at least one token");
    }
  }

  async authorize(required: Permission, ctx: AuthContext): Promise<AuthIdentity> {
    if (!ctx.token) {
      throw new AuthError(
        `Missing _authToken in tool call (tool requires ${required} permission). Pass _authToken=<your token> in the tool arguments.`
      );
    }
    const presented = Buffer.from(ctx.token, "utf8");
    // Compare against every entry; don't short-circuit on the first match so
    // the loop's work doesn't vary with which token was presented.
    let matched: TokenEntry | undefined;
    for (const entry of this.tokens) {
      if (
        presented.length === entry.secret.length &&
        timingSafeEqual(presented, entry.secret)
      ) {
        matched = entry;
      }
    }
    if (!matched) {
      throw new AuthError("Invalid _authToken");
    }
    const identity: AuthIdentity = {
      name: matched.name,
      privileges: matched.privileges,
    };
    if (RANK[required] > matched.level) {
      throw new AuthError(
        `Token '${matched.name}' lacks the '${required}' privilege (granted: ${matched.privileges.join(", ")}).`,
        identity
      );
    }
    return identity;
  }

  modeName(): string {
    return `static-secret (${this.tokens.length} token${this.tokens.length === 1 ? "" : "s"})`;
  }
}

/** Build a validated TokenEntry from a raw secret + privilege list. */
function makeTokenEntry(name: string, secret: string, privileges: Permission[]): TokenEntry {
  if (secret.length < 16) {
    throw new Error(
      `Token '${name}' is too short (min 16 chars); generate with \`openssl rand -base64 24\``
    );
  }
  if (privileges.length === 0) {
    throw new Error(`Token '${name}' must grant at least one privilege`);
  }
  const effective = expandPrivileges(privileges);
  return {
    name,
    secret: Buffer.from(secret, "utf8"),
    level: Math.max(...privileges.map((p) => RANK[p])),
    privileges: effective,
  };
}

/**
 * Resolve the tokens-file path. MCP_TOKENS_FILE may be absolute or relative to
 * the current working directory; unset defaults to mcp-server/env/tokens.json
 * (sibling of the server's .env, resolved from this module's location so it
 * works from both dist/ and src/).
 */
function resolveTokensPath(override: string | undefined): string {
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : resolve(override);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../env/tokens.json");
}

/**
 * Load and validate the tokens file. Returns [] if the file is absent (so the
 * legacy single-token path can still satisfy boot). Throws on malformed JSON,
 * bad shape, duplicate names, or unknown privilege strings — a broken tokens
 * file is a security problem, not something to silently ignore.
 */
function loadTokensFile(path: string): TokenEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // absent → caller fails boot (no tokens configured)
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Tokens file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Tokens file ${path} must be a JSON array of {name, token, privileges}`);
  }
  const entries: TokenEntry[] = [];
  const seenNames = new Set<string>();
  parsed.forEach((raw, i) => {
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const token = typeof o.token === "string" ? o.token : "";
    const privs = o.privileges;
    if (!name) throw new Error(`Tokens file ${path}: entry ${i} is missing "name"`);
    if (!token) throw new Error(`Tokens file ${path}: entry '${name}' is missing "token"`);
    if (seenNames.has(name)) throw new Error(`Tokens file ${path}: duplicate name '${name}'`);
    if (!Array.isArray(privs) || privs.length === 0) {
      throw new Error(`Tokens file ${path}: entry '${name}' needs a non-empty "privileges" array`);
    }
    for (const p of privs) {
      if (typeof p !== "string" || !isPermission(p)) {
        throw new Error(
          `Tokens file ${path}: entry '${name}' has invalid privilege ${JSON.stringify(p)} (use read|write|delete)`
        );
      }
    }
    seenNames.add(name);
    entries.push(makeTokenEntry(name, token, privs as Permission[]));
  });
  return entries;
}

/**
 * Production mode: each call carries an OAuth bearer via `_authToken`. We
 * introspect it against AM and check the scope.
 *
 * Planned implementation (not done — throws NotImplemented):
 *   1. POST {amBaseUrl}/oauth2/introspect with the bearer (basic-auth as the
 *      mcp-server's own client_id/secret).
 *   2. Verify { active: true, scope: contains required scope, exp > now }.
 *   3. Cache the introspection result for ~30s keyed by token to amortize.
 *
 * Scope shape (chosen): two coarse scopes
 *   - "forgerock.read"  → Permission.read
 *   - "forgerock.write" → Permission.write (implicitly grants read too)
 *
 * The OAuth2 client representing the MCP server lives in AM and is bootstrapped
 * separately (script TBD).
 */
export class OAuthAmAuthenticator implements Authenticator {
  constructor(
    private readonly _amBaseUrl: string,
    private readonly _clientId: string,
    private readonly _clientSecret: string
  ) {}

  async authorize(required: Permission, ctx: AuthContext): Promise<AuthIdentity> {
    if (!ctx.token) {
      throw new AuthError(`Missing _authToken; tool requires ${required} permission`);
    }
    throw new AuthError(
      "OAuth-via-AM authenticator is not implemented yet; set MCP_AUTH_MODE=static for now"
    );
  }

  modeName(): string {
    return "oauth-am (prod) [STUB]";
  }
}

/**
 * Boot-time selector. Errors with a clear message if the env is mis-set, since
 * a misconfigured auth gate is a security issue, not something to fall back from.
 */
/**
 * In static mode every token comes from the tokens file (MCP_TOKENS_FILE,
 * default mcp-server/env/tokens.json) — each entry carries its own privilege
 * scope. There is no legacy single-secret fallback; a server with no tokens
 * file fails to boot rather than running unauthenticated. The folder boundary
 * still holds: this never reads agent/env/.env or ops/env/.env.
 *
 * Why a separate ProcessEnv arg? Tests can pass a fake; production passes
 * process.env (or the merged env from loadEnv() if you want dotenv fallback).
 */
export function loadAuthenticator(
  processEnv: Record<string, string | undefined> = process.env
): Authenticator {
  const mode = processEnv.MCP_AUTH_MODE ?? "static";
  if (mode === "static") {
    const entries = loadTokensFile(resolveTokensPath(processEnv.MCP_TOKENS_FILE));
    if (entries.length === 0) {
      throw new Error(
        "mode=static needs at least one token: provide a tokens file (default mcp-server/env/tokens.json, override with MCP_TOKENS_FILE) with [{name, token, privileges:[read|write|delete]}]. Generate token values with `openssl rand -base64 24`. Each token is presented by the agent as _authToken (or an Authorization: Bearer header) on every call."
      );
    }
    return new StaticSecretAuthenticator(entries);
  }
  if (mode === "oauth-am") {
    const amBaseUrl = processEnv.AM_BASE_URL;
    const clientId = processEnv.MCP_OAUTH_CLIENT_ID;
    const clientSecret = processEnv.MCP_OAUTH_CLIENT_SECRET;
    if (!amBaseUrl || !clientId || !clientSecret) {
      throw new Error(
        "MCP_AUTH_MODE=oauth-am requires AM_BASE_URL, MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET in the server's process environment."
      );
    }
    return new OAuthAmAuthenticator(amBaseUrl, clientId, clientSecret);
  }
  if (mode === "disabled") {
    if (processEnv.MCP_AUTH_DISABLED_ACK !== "true") {
      throw new Error(
        "MCP_AUTH_MODE=disabled requires MCP_AUTH_DISABLED_ACK=true to acknowledge the security implication."
      );
    }
    return new DisabledAuthenticator();
  }
  throw new Error(`Unknown MCP_AUTH_MODE='${mode}'. Use 'static', 'oauth-am', or 'disabled'.`);
}

/** For testing/migration only. Refuses to start unless MCP_AUTH_DISABLED_ACK=true. */
class DisabledAuthenticator implements Authenticator {
  async authorize(): Promise<AuthIdentity> {
    return { name: "disabled", privileges: ALL_PERMISSIONS };
  }
  modeName(): string {
    return "disabled (NO AUTH)";
  }
}
