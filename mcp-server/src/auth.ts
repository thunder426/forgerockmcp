/**
 * MCP-side authentication.
 *
 * Architecture: server and agent are separate. Each holds the shared secret
 * independently — server from its own process env (MCP_SERVER_TOKEN), agent
 * from its host config. They never share a filesystem; the token only travels
 * in the tool-call payload as `_authToken`.
 *
 * Modes:
 *   - static (local/dev): server validates each call's _authToken against
 *     MCP_SERVER_TOKEN with a constant-time compare. Same mechanism in dev
 *     and (cheap) prod; just the secret distribution differs.
 *   - oauth-am (prod): each call's _authToken is an OAuth2 bearer the server
 *     introspects against AM and scope-checks. Stubbed below.
 *
 * AM still gets hit with `amadmin` regardless of mode — this gate decides
 * *who is allowed to call the MCP*, not *how the MCP talks to AM*.
 */
import { timingSafeEqual } from "node:crypto";

export type Permission = "read" | "write";

export interface AuthContext {
  /** The OAuth bearer token presented in this call (prod). Undefined in local mode. */
  token?: string;
}

export interface Authenticator {
  /** Throws if the call is not authorized. Must include the permission requested in the error. */
  authorize(required: Permission, ctx: AuthContext): Promise<void>;
  /** Human-readable mode name for boot logging. */
  modeName(): string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Static-secret mode. Validates each call's `_authToken` against the
 * server-side MCP_SERVER_TOKEN with a constant-time compare. The agent must
 * pass the same string in every tool call's `_authToken` arg.
 */
export class StaticSecretAuthenticator implements Authenticator {
  private readonly expected: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) {
      throw new Error(
        "MCP_SERVER_TOKEN must be at least 16 characters; generate with `openssl rand -base64 24`"
      );
    }
    this.expected = Buffer.from(secret, "utf8");
  }

  async authorize(required: Permission, ctx: AuthContext): Promise<void> {
    if (!ctx.token) {
      throw new AuthError(
        `Missing _authToken in tool call (tool requires ${required} permission). Pass _authToken=<your token> in the tool arguments.`
      );
    }
    const presented = Buffer.from(ctx.token, "utf8");
    if (presented.length !== this.expected.length || !timingSafeEqual(presented, this.expected)) {
      throw new AuthError("Invalid _authToken");
    }
  }

  modeName(): string {
    return "static-secret";
  }
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

  async authorize(required: Permission, ctx: AuthContext): Promise<void> {
    if (!ctx.token) {
      throw new AuthError(`Missing _authToken; tool requires ${required} permission`);
    }
    throw new AuthError(
      "OAuth-via-AM authenticator is not implemented yet; set MCP_AUTH_MODE=local for now"
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
 * The server reads its own credentials from process.env directly. The
 * server-side dotenv (mcp-server/env/.env) is loaded by config.ts for the
 * non-secret AM_* config; the auth secret is checked here too as a fallback so
 * that `MCP_SERVER_TOKEN` written into mcp-server/env/.env by ops/scripts works
 * out of the box. The folder boundary still holds: this never reads
 * agent/env/.env or ops/env/.env.
 *
 * In production, prefer setting MCP_SERVER_TOKEN purely via process.env (k8s
 * Secret → env, systemd unit, etc.) and leaving the server dotenv unset for it.
 *
 * Why a separate ProcessEnv arg? Tests can pass a fake; production passes
 * process.env (or the merged env from loadEnv() if you want dotenv fallback).
 */
export function loadAuthenticator(
  processEnv: Record<string, string | undefined> = process.env
): Authenticator {
  const mode = processEnv.MCP_AUTH_MODE ?? "static";
  if (mode === "static") {
    const secret = processEnv.MCP_SERVER_TOKEN;
    if (!secret) {
      throw new Error(
        "MCP_SERVER_TOKEN is required (mode=static). Set it in the SERVER's process environment — not in env/local/.env, which the agent could read. Generate with `openssl rand -base64 24`. The agent must be told the same value out-of-band and must pass it as _authToken on every tool call."
      );
    }
    return new StaticSecretAuthenticator(secret);
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
  async authorize(): Promise<void> {}
  modeName(): string {
    return "disabled (NO AUTH)";
  }
}
