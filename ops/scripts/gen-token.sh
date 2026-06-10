#!/usr/bin/env bash
# Generate a fresh shared MCP secret and write both halves:
#   - mcp-server/env/.env: MCP_SERVER_TOKEN=<token>
#   - agent/env/.env:      FORGEROCK_AGENT_TOKEN=<token>
#
# This is a DEV convenience. In production the two sides are provisioned
# independently by separate humans/systems — ops would NOT have write access
# to both sides at once. We do it here to keep `make` smooth.
#
# Idempotent: running again rotates both halves.

source "$(dirname "$0")/lib.sh"

if [[ ! -f "$SERVER_ENV_FILE" ]]; then
  err "Missing $SERVER_ENV_FILE. Copy mcp-server/env/.env.example to mcp-server/env/.env first."
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

write_var "$SERVER_ENV_FILE" MCP_SERVER_TOKEN "$TOKEN"
write_var "$AGENT_ENV_FILE"  FORGEROCK_AGENT_TOKEN "$TOKEN"

ok "wrote MCP_SERVER_TOKEN to $SERVER_ENV_FILE"
ok "wrote FORGEROCK_AGENT_TOKEN to $AGENT_ENV_FILE"
log "rotate again any time with: make token"
