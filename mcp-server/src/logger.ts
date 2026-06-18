/**
 * Tool-usage logger. Records one structured JSONL line per tool call the agent
 * makes, so we have an audit trail of what the agent did, when, and whether it
 * succeeded.
 *
 * Two sinks, independently toggleable:
 *   - a JSONL file (default mcp-server/logs/tool-usage.log) for durable audit
 *   - stderr, for live visibility when the server is run via an MCP host
 *
 * NEVER stdout — that's the MCP transport (see CLAUDE.md). Writes go to a file
 * or stderr only.
 *
 * Arg values can carry secrets (passwords, the per-call token), so args are
 * redacted before logging and only included when MCP_LOG_ARGS=true; the key
 * names are always recorded so you can see the shape of every call.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ToolCallRecord {
  /** ISO-8601 timestamp of when the call completed. */
  ts: string;
  /** Which transport the call arrived on. */
  transport: "stdio" | "http";
  /** Tool name as requested by the agent. */
  tool: string;
  /** "read" | "write" | "delete" from the tool's registration, or "unknown" if no such tool. */
  permission: string;
  /** Label of the token that made the call (from the tokens file); undefined if unauthenticated. */
  tokenName?: string;
  /** Outcome bucket. */
  status: "ok" | "error" | "auth_error" | "unknown_tool";
  /** Wall-clock duration of the handler dispatch, in milliseconds. */
  durationMs: number;
  /** Keys present in the call arguments (always recorded; cheap and secret-free). */
  argKeys: string[];
  /** Redacted argument values — only set when MCP_LOG_ARGS=true. */
  args?: Record<string, unknown>;
  /** Error message, only set when status is "error" or "auth_error". */
  error?: string;
}

export interface ToolLogger {
  /** Queue a record for writing. Fire-and-forget; never throws. */
  record(rec: ToolCallRecord): void;
  /** The resolved log file path, or null if file logging is disabled. */
  filePath: string | null;
  /** Whether stderr mirroring is on. */
  stderr: boolean;
  /** Whether redacted arg values are included. */
  logArgs: boolean;
}

const SECRET_KEY = /pass(word)?|secret|token|credential|_authtoken/i;

/** Replace values of secret-looking keys with a marker, recursively. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

function truthy(v: string | undefined): boolean {
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Build a tool logger from the merged env. Knobs:
 *   MCP_LOG_TOOL_USAGE = false   → disable file logging entirely (default on)
 *   MCP_LOG_FILE       = <path>  → override the JSONL path; "off"/"none"/"" disables file sink
 *   MCP_LOG_ARGS       = true    → include redacted arg values (default off; keys always logged)
 *   MCP_LOG_STDERR     = false   → silence the concise stderr mirror (default on)
 */
export function createToolLogger(
  env: Record<string, string | undefined>
): ToolLogger {
  const enabled = env.MCP_LOG_TOOL_USAGE !== "false";
  const stderr = env.MCP_LOG_STDERR !== "false";
  const logArgs = truthy(env.MCP_LOG_ARGS);

  let filePath: string | null = null;
  if (enabled) {
    const raw = env.MCP_LOG_FILE;
    if (raw === "off" || raw === "none" || raw === "") {
      filePath = null;
    } else if (raw) {
      filePath = resolve(raw);
    } else {
      // Default: mcp-server/logs/tool-usage.log, sibling of dist/ and src/.
      const here = dirname(fileURLToPath(import.meta.url));
      filePath = resolve(here, "../logs/tool-usage.log");
    }
  }

  // Serialize file appends so concurrent HTTP requests can't interleave a line.
  let writeChain: Promise<void> = Promise.resolve();
  let dirReady = false;

  const writeFile = (line: string): void => {
    if (!filePath) return;
    const path = filePath;
    writeChain = writeChain
      .then(async () => {
        if (!dirReady) {
          await mkdir(dirname(path), { recursive: true });
          dirReady = true;
        }
        await appendFile(path, line + "\n", "utf8");
      })
      .catch((err) => {
        // Logging must never take down a tool call. Surface to stderr and move on.
        process.stderr.write(`tool-usage log write failed: ${String(err)}\n`);
      });
  };

  return {
    filePath,
    stderr,
    logArgs,
    record(rec: ToolCallRecord): void {
      if (!enabled && !stderr) return;
      const full: ToolCallRecord = logArgs
        ? rec
        : // Drop the args object but keep argKeys when not logging values.
          { ...rec, args: undefined };
      if (filePath) writeFile(JSON.stringify(full));
      if (stderr) {
        const tag = full.status === "ok" ? "ok" : full.status.toUpperCase();
        const who = full.tokenName ? ` by ${full.tokenName}` : "";
        const errPart = full.error ? ` — ${full.error}` : "";
        process.stderr.write(
          `[tool] ${full.tool} (${full.permission})${who} ${tag} ${full.durationMs}ms${errPart}\n`
        );
      }
    },
  };
}

/** Redact and shallow-cap an args object for logging. Exposed for the dispatcher. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redact(args) as Record<string, unknown>;
}
