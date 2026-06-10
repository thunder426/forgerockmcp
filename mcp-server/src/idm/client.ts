import { Agent, fetch as undiciFetch } from "undici";

export interface IdmClientConfig {
  /**
   * The same base URL the AmClient uses — typically includes `/am` as the
   * trailing context path (e.g. `https://forgeops.example.com/am`). The client
   * normalizes it: AM endpoints are called at `<baseUrl>/...` and IDM
   * endpoints at `<host-of-baseUrl>/openidm/...`. Both AM and IDM are served
   * from the same host in ForgeOps.
   */
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  insecureTls?: boolean;
}

export class IdmError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "IdmError";
  }
}

/**
 * IDM REST client.
 *
 * Auth model: IDM's rsFilter only accepts OAuth2 bearer tokens — not the session
 * cookies AM admin REST uses. We get a bearer by doing an authorization_code
 * flow as amadmin against the `idm-admin-ui` public client, then call IDM with
 * that bearer. IDM's staticUserMapping for `sub: amadmin` routes us to the
 * internal `openidm-admin` principal with full write access.
 *
 * AM-created users are invisible to IDM's managed/user `_queryFilter` (see
 * project memory: am-created-users-invisible-to-idm-query). To make a user
 * visible to IDM, create it through IDM here.
 */
export class IdmClient {
  private bearer?: string;
  private bearerExpiresAt = 0;
  private readonly agent?: Agent;
  /** Origin (scheme + host[:port]) — used to build /openidm/* URLs. */
  private readonly origin: string;
  /** Full AM base URL including the /am context — used for AM auth calls. */
  private readonly amBase: string;

  constructor(private readonly cfg: IdmClientConfig) {
    if (cfg.insecureTls) {
      this.agent = new Agent({ connect: { rejectUnauthorized: false } });
    }
    this.amBase = cfg.baseUrl.replace(/\/$/, "");
    this.origin = new URL(this.amBase).origin;
  }

  /**
   * Mint a fresh amadmin bearer via AM's OAuth2 authorization_code flow.
   * Public client (idm-admin-ui), so no client secret needed.
   */
  private async mintBearer(): Promise<void> {
    const redirectUri = `${this.origin}/platform/appAuthHelperRedirect.html`;

    // Step 1: session login as amadmin against /root
    const info = await this.fetchJson(`${this.amBase}/json/serverinfo/*`, { method: "GET" });
    const cookieName: string = info.cookieName;
    const auth = await this.fetchJson(`${this.amBase}/json/realms/root/authenticate`, {
      method: "POST",
      body: "{}",
      contentType: "application/json",
      headers: {
        "X-OpenAM-Username": this.cfg.adminUser,
        "X-OpenAM-Password": this.cfg.adminPassword,
        "Accept-API-Version": "resource=2.0, protocol=1.0",
      },
    });
    if (!auth.tokenId) {
      throw new IdmError("amadmin login failed", 401, auth);
    }
    const sso: string = auth.tokenId;

    // Step 2: authorize → code
    const authorizeParams = new URLSearchParams({
      client_id: "idm-admin-ui",
      response_type: "code",
      scope: "openid fr:idm:*",
      redirect_uri: redirectUri,
      decision: "allow",
      csrf: sso,
    });
    const authorizeUrl = `${this.amBase}/oauth2/realms/root/authorize?${authorizeParams.toString()}`;
    const authorizeRes = await undiciFetch(authorizeUrl, {
      method: "GET",
      redirect: "manual",
      headers: { [cookieName]: sso },
      dispatcher: this.agent,
    });
    const location = authorizeRes.headers.get("location");
    if (!location) {
      const body = await authorizeRes.text();
      throw new IdmError(
        `authorize returned no Location header (status ${authorizeRes.status})`,
        authorizeRes.status,
        body
      );
    }
    const codeMatch = location.match(/[?&]code=([^&]+)/);
    if (!codeMatch) {
      throw new IdmError(`authorize redirect missing code: ${location}`, 400, location);
    }
    const code = decodeURIComponent(codeMatch[1]);

    // Step 3: code → access_token
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "idm-admin-ui",
      redirect_uri: redirectUri,
    });
    const tokenRes = await this.fetchJson(`${this.amBase}/oauth2/realms/root/access_token`, {
      method: "POST",
      body: tokenBody.toString(),
      contentType: "application/x-www-form-urlencoded",
    });
    if (!tokenRes.access_token) {
      throw new IdmError("token exchange failed", 400, tokenRes);
    }
    this.bearer = tokenRes.access_token;
    // expires_in is seconds; refresh 60s before expiry to avoid races
    const ttl = Math.max(0, (tokenRes.expires_in ?? 3600) - 60);
    this.bearerExpiresAt = Date.now() + ttl * 1000;
  }

  private async ensureBearer(): Promise<string> {
    if (!this.bearer || Date.now() >= this.bearerExpiresAt) {
      await this.mintBearer();
    }
    return this.bearer!;
  }

  async get(path: string): Promise<any> {
    return this.authedRequest("GET", path);
  }

  async post(path: string, body: unknown): Promise<any> {
    return this.authedRequest("POST", path, body);
  }

  async put(path: string, body: unknown, ifMatch?: string): Promise<any> {
    return this.authedRequest("PUT", path, body, ifMatch ? { "If-Match": ifMatch } : undefined);
  }

  async patch(path: string, ops: unknown[], ifMatch?: string): Promise<any> {
    return this.authedRequest("PATCH", path, ops, ifMatch ? { "If-Match": ifMatch } : undefined);
  }

  async delete(path: string): Promise<any> {
    return this.authedRequest("DELETE", path);
  }

  private async authedRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<any> {
    const url = `${this.origin}/openidm${path}`;
    const callOnce = async (): Promise<any> => {
      const bearer = await this.ensureBearer();
      return this.fetchJson(url, {
        method,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        contentType: body !== undefined ? "application/json" : undefined,
        headers: { Authorization: `Bearer ${bearer}`, ...(extraHeaders ?? {}) },
      });
    };
    try {
      return await callOnce();
    } catch (err) {
      if (err instanceof IdmError && err.status === 401) {
        // Bearer expired or revoked — refresh and retry once.
        this.bearer = undefined;
        return callOnce();
      }
      throw err;
    }
  }

  private async fetchJson(
    url: string,
    opts: {
      method: string;
      body?: string;
      contentType?: string;
      headers?: Record<string, string>;
    }
  ): Promise<any> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    const res = await undiciFetch(url, {
      method: opts.method,
      headers,
      body: opts.body,
      dispatcher: this.agent,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new IdmError(`IDM ${opts.method} ${url} failed: ${res.status}`, res.status, parsed);
    }
    return parsed;
  }
}
