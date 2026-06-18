#!/usr/bin/env bash
# Rotate the interactive agent's MCP token and write both halves:
#   - mcp-server/env/tokens.json: the "interactive-agent" entry's "token"
#                                 (created with privileges ["delete"] if absent)
#   - agent/env/.env:             FORGEROCK_AGENT_TOKEN=<token>
#
# This is a DEV convenience. In production the two sides are provisioned
# independently by separate humans/systems — ops would NOT have write access
# to both sides at once. We do it here to keep `make` smooth.
#
# The server no longer honours a single MCP_SERVER_TOKEN: every credential is
# an entry in tokens.json with its own privilege scope (read|write|delete).
# This script rotates just the agent's entry; the other tokens are left alone.
#
# Idempotent: running again rotates the same entry.

source "$(dirname "$0")/lib.sh"

# Which tokens.json entry this script owns. Override to rotate a different one.
TOKEN_NAME="${MCP_AGENT_TOKEN_NAME:-interactive-agent}"
TOKENS_FILE="${REPO_ROOT}/mcp-server/env/tokens.json"

command -v jq >/dev/null 2>&1 || { err "jq is required (brew install jq, or run 'make install')."; exit 1; }

if [[ ! -f "$TOKENS_FILE" ]]; then
  err "Missing $TOKENS_FILE. Copy mcp-server/env/tokens.json.example to it first."
  exit 1
fi
if [[ ! -f "$AGENT_ENV_FILE" ]]; then
  err "Missing $AGENT_ENV_FILE. Copy agent/env/.env.example to agent/env/.env first."
  exit 1
fi

TOKEN="$(openssl rand -base64 24 | tr -d '+/=')"

write_var() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i '' "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

# Upsert the named entry in tokens.json: rotate its token if present, else add
# it with delete privilege. Leaves every other token untouched.
tmp="$(mktemp)"
jq --arg name "$TOKEN_NAME" --arg tok "$TOKEN" '
  if any(.[]; .name == $name)
  then map(if .name == $name then .token = $tok else . end)
  else . + [{name: $name, token: $tok, privileges: ["delete"]}]
  end
' "$TOKENS_FILE" > "$tmp" && mv "$tmp" "$TOKENS_FILE"

write_var "$AGENT_ENV_FILE" FORGEROCK_AGENT_TOKEN "$TOKEN"

ok "rotated '$TOKEN_NAME' token in $TOKENS_FILE"
ok "wrote FORGEROCK_AGENT_TOKEN to $AGENT_ENV_FILE"
warn "Restart the MCP server (npm run start:http) so it reloads tokens.json."
warn "If your MCP host pins the token in an Authorization header (e.g. ~/.claude.json),"
warn "update that Bearer value to the new token and restart the host."
log "rotate again any time with: make token"
