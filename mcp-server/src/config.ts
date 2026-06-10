/**
 * Server config. Values come from (in order of precedence):
 *   1. process.env (set by the MCP host or the shell)
 *   2. mcp-server/env/.env (server-side dotenv)
 *
 * Server-side only: this loader will NEVER read agent/env/.env or ops/env/.env.
 * The folder boundary is enforced here. Cross-folder writes (e.g. ops scripts
 * populating mcp-server/env/.env after stack bringup) are intentional and
 * happen one-way from ops at install time, never at runtime.
 *
 * AM_INSECURE_TLS=true accepts the self-signed cert that ForgeOps generates.
 * Required for local dev; should never be true in production.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  amBaseUrl: string;
  amRealm: string;
  amAdminUser: string;
  amAdminPassword: string;
  amInsecureTls: boolean;
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip inline comments (# preceded by whitespace), but not inside quotes.
    if (!(val.startsWith('"') || val.startsWith("'"))) {
      const hash = val.search(/\s#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    // Strip surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadDotenv(): Record<string, string> {
  // Server-side dotenv: mcp-server/env/.env relative to this file's location.
  // dist/config.js → ../env/.env. src/config.ts (via tsx) → ../env/.env.
  // Both resolve to the same path because dist/ and src/ are siblings of env/.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../env/.env"), // dist/ and src/ both resolve here
  ];
  for (const p of candidates) {
    try {
      return parseDotenv(readFileSync(p, "utf8"));
    } catch {
      // try next
    }
  }
  return {};
}

/**
 * Merged env lookup: process.env wins, env/local/.env is the fallback.
 * Empty-string values from process.env are treated as unset (Claude Code's
 * .mcp.json substitutes "${VAR}" with "" when VAR isn't in the shell, and we
 * want the .env value to win in that case).
 */
export function loadEnv(): Record<string, string | undefined> {
  const fileEnv = loadDotenv();
  return new Proxy({} as Record<string, string | undefined>, {
    get(_t, name: string) {
      const fromProc = process.env[name];
      if (fromProc !== undefined && fromProc !== "") return fromProc;
      return fileEnv[name];
    },
    has(_t, name: string) {
      const fromProc = process.env[name];
      if (fromProc !== undefined && fromProc !== "") return true;
      return name in fileEnv;
    },
  });
}

export function loadConfig(env: Record<string, string | undefined> = loadEnv()): ServerConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  return {
    amBaseUrl: required("AM_BASE_URL").replace(/\/$/, ""),
    amRealm: env.AM_REALM || "root",
    amAdminUser: required("AM_ADMIN_USER"),
    amAdminPassword: required("AM_ADMIN_PASSWORD"),
    amInsecureTls: env.AM_INSECURE_TLS === "true",
  };
}
