import { Agent, fetch as undiciFetch } from "undici";

export interface AmClientConfig {
  baseUrl: string;
  realm: string;
  adminUser: string;
  adminPassword: string;
  insecureTls?: boolean;
}

export class AmError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "AmError";
  }
}

/**
 * AM REST client.
 *
 * Session model: AM admin REST APIs (/realm-config/*) only accept session-token
 * authentication, not OAuth2 bearer tokens. We log in once, cache the tokenId,
 * and re-authenticate on 401.
 *
 * Realm path: AM's URL grammar nests realms as `/realms/root/realms/<name>`.
 * Root maps to `/realms/root`. The realmPath() helper handles this.
 */
export class AmClient {
  private tokenId?: string;
  private cookieName?: string;
  private readonly agent?: Agent;

  constructor(private readonly cfg: AmClientConfig) {
    if (cfg.insecureTls) {
      this.agent = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  /** Build a realm-scoped path segment. realm='root' -> 'root', else 'root/realms/<name>'. */
  realmPath(realm = this.cfg.realm): string {
    return realm === "root" || !realm ? "root" : `root/realms/${realm}`;
  }

  /** Login and cache the session token. */
  async login(): Promise<void> {
    const info = await this.rawJson("GET", "/json/serverinfo/*");
    this.cookieName = info.cookieName;

    // Force the ldapService chain rather than whatever the /root org default
    // is — the default is configurable per-realm and operators sometimes point
    // it at an MFA-enabled tree (e.g. UP-MFA-Demo in this stack), which would
    // break header-based amadmin login. ldapService is the historical default
    // and stays plain username/password.
    const auth = await this.rawJson(
      "POST",
      "/json/realms/root/authenticate?authIndexType=service&authIndexValue=ldapService",
      {},
      {
        "X-OpenAM-Username": this.cfg.adminUser,
        "X-OpenAM-Password": this.cfg.adminPassword,
        "Accept-API-Version": "resource=2.0, protocol=1.0",
      }
    );
    if (!auth.tokenId) {
      throw new AmError("Login failed", 401, auth);
    }
    this.tokenId = auth.tokenId;
  }

  /** Authenticated GET on a realm-scoped path, e.g. realmGet('/realm-config/foo'). */
  async realmGet(path: string, realm?: string, apiVersion?: string): Promise<any> {
    return this.authedRequest("GET", `/json/realms/${this.realmPath(realm)}${path}`, undefined, apiVersion);
  }

  async realmPost(
    path: string,
    body: unknown,
    realm?: string,
    apiVersion?: string
  ): Promise<any> {
    return this.authedRequest("POST", `/json/realms/${this.realmPath(realm)}${path}`, body, apiVersion);
  }

  async realmPut(
    path: string,
    body: unknown,
    realm?: string,
    apiVersion?: string,
    extraHeaders?: Record<string, string>
  ): Promise<any> {
    return this.authedRequest(
      "PUT",
      `/json/realms/${this.realmPath(realm)}${path}`,
      body,
      apiVersion,
      extraHeaders
    );
  }

  async realmDelete(path: string, realm?: string, apiVersion?: string): Promise<any> {
    return this.authedRequest("DELETE", `/json/realms/${this.realmPath(realm)}${path}`, undefined, apiVersion);
  }

  /** Top-level (non-realm-scoped) calls. /json/global-config/* etc. */
  async globalGet(path: string, apiVersion?: string): Promise<any> {
    return this.authedRequest("GET", path, undefined, apiVersion);
  }

  async globalPost(path: string, body: unknown, apiVersion?: string): Promise<any> {
    return this.authedRequest("POST", path, body, apiVersion);
  }

  async globalDelete(path: string, apiVersion?: string): Promise<any> {
    return this.authedRequest("DELETE", path, undefined, apiVersion);
  }

  private async authedRequest(
    method: string,
    path: string,
    body?: unknown,
    apiVersion = "protocol=2.1, resource=1.0",
    extraHeaders?: Record<string, string>
  ): Promise<any> {
    if (!this.tokenId) await this.login();
    const buildHeaders = () => ({
      [this.cookieName!]: this.tokenId!,
      "Accept-API-Version": apiVersion,
      ...(extraHeaders ?? {}),
    });
    try {
      return await this.rawJson(method, path, body, buildHeaders());
    } catch (err) {
      if (err instanceof AmError && err.status === 401) {
        // Session expired — re-auth once and retry.
        await this.login();
        return this.rawJson(method, path, body, buildHeaders());
      }
      throw err;
    }
  }

  private async rawJson(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<any> {
    const url = `${this.cfg.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await undiciFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
      throw new AmError(
        `AM ${method} ${path} failed: ${res.status}`,
        res.status,
        parsed
      );
    }
    return parsed;
  }
}
