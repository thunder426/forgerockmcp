#!/usr/bin/env bash
# Create a dedicated admin user the MCP server will use to talk to AM.
#
# Why not just use amadmin? amadmin is the super-user with no audit separation
# and bypasses most authorization checks. The MCP needs:
#   - Read/write journeys (authentication trees + nodes)
#   - Read/write scripts
#   - Read identities (for journey testing)
# 'ui-realm-admin' on the target realm is the least-privilege role that covers all of these.
#
# Notes on the platform-shared DS:
#   - This DS is shared with IDM, so user entries carry the IDM-required 'fr-idm-uuid' attribute
#     which DS validates as a strict 36-byte UUID. PUT-by-username (which would try to set
#     _id = username) fails. We use POST + _action=create so AM auto-assigns the UUID.
#
# Idempotent — safe to re-run.

source "$(dirname "$0")/lib.sh"

AM_BASE="https://${FQDN}/am"
# Realm in which to create the mcp-admin user. Mirror what the server uses
# (read from mcp-server/env/.env if present), default to root otherwise.
AM_REALM="$(grep -E '^AM_REALM=' "$SERVER_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | awk '{print $1}')"
AM_REALM="${AM_REALM:-root}"
if [[ "$AM_REALM" == "root" || -z "$AM_REALM" ]]; then
  REALM_PATH="root"
else
  REALM_PATH="root/realms/${AM_REALM}"
fi
REALM_BASE="${AM_BASE}/json/realms/${REALM_PATH}"

COOKIE_NAME=$(curl -sk "${AM_BASE}/json/serverinfo/*" | jq -r .cookieName)
[[ -n "$COOKIE_NAME" && "$COOKIE_NAME" != "null" ]] || { err "cannot reach AM at ${AM_BASE}"; exit 1; }
ok "AM reachable, cookie name = $COOKIE_NAME"

# Pull the amadmin password from the forgeops-generated secret.
AM_ADMIN_PASSWORD=$(kubectl get secret am-env-secrets -n "$NAMESPACE" \
  -o jsonpath='{.data.AM_PASSWORDS_AMADMIN_CLEAR}' | base64 -d)
[[ -n "$AM_ADMIN_PASSWORD" ]] || { err "could not fetch amadmin password from cluster"; exit 1; }

# Persist the amadmin password to mcp-server/env/.env so the SERVER (which reads
# its own dotenv) can authenticate. Note this is a cross-folder write — ops is
# the privileged side that can do it; the server itself only reads.
if [[ ! -f "$SERVER_ENV_FILE" ]]; then
  err "Missing $SERVER_ENV_FILE. Copy mcp-server/env/.env.example to mcp-server/env/.env first."
  exit 1
fi
if grep -q '^AM_ADMIN_PASSWORD=' "$SERVER_ENV_FILE"; then
  sed -i '' "s|^AM_ADMIN_PASSWORD=.*|AM_ADMIN_PASSWORD=${AM_ADMIN_PASSWORD}|" "$SERVER_ENV_FILE"
else
  echo "AM_ADMIN_PASSWORD=${AM_ADMIN_PASSWORD}" >> "$SERVER_ENV_FILE"
fi
log "Wrote AM_ADMIN_PASSWORD into $SERVER_ENV_FILE"

# Persist the MCP admin password back to ops/env/.env on first run.
# Generates one if the placeholder hasn't been replaced.
if [[ -z "${MCP_ADMIN_PASSWORD:-}" || "$MCP_ADMIN_PASSWORD" == *"ChangeMe"* || "$MCP_ADMIN_PASSWORD" == "McpAdmin#Local2026!Strong" ]]; then
  MCP_ADMIN_PASSWORD="Mcp$(openssl rand -base64 24 | tr -d '+/=' | head -c 24)!1"
  log "Generated MCP_ADMIN_PASSWORD and writing to ops/env/.env"
  if grep -q '^MCP_ADMIN_PASSWORD=' "$ENV_FILE"; then
    sed -i '' "s|^MCP_ADMIN_PASSWORD=.*|MCP_ADMIN_PASSWORD=${MCP_ADMIN_PASSWORD}|" "$ENV_FILE"
  else
    echo "MCP_ADMIN_PASSWORD=${MCP_ADMIN_PASSWORD}" >> "$ENV_FILE"
  fi
fi

# 1. Admin login -> tokenId
log "Authenticating as ${AM_ADMIN_USER}"
TOKEN=$(curl -sk -X POST "${AM_BASE}/json/realms/root/authenticate" \
  -H "Content-Type: application/json" \
  -H "X-OpenAM-Username: ${AM_ADMIN_USER}" \
  -H "X-OpenAM-Password: ${AM_ADMIN_PASSWORD}" \
  -H "Accept-API-Version: resource=2.0, protocol=1.0" \
  -d '{}' | jq -r .tokenId)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { err "amadmin login failed"; exit 1; }
ok "got admin session token"

auth_hdr=(-H "${COOKIE_NAME}: ${TOKEN}" -H "Accept-API-Version: resource=4.0, protocol=2.1")

# 2. Look up the user by uid (idempotent path).
# Note: AM REST exposes 'username' as a virtual attribute; _queryFilter equality only works
# on the underlying LDAP attribute 'uid'. Querying 'username eq ...' silently returns empty.
log "Checking if user ${MCP_ADMIN_USER} exists in realm ${AM_REALM}"
existing=$(curl -sk "${auth_hdr[@]}" \
  --get \
  --data-urlencode "_queryFilter=uid eq \"${MCP_ADMIN_USER}\"" \
  --data-urlencode "_fields=username,_id" \
  "${REALM_BASE}/users")
existing_id=$(echo "$existing" | jq -r '.result[0]._id // empty')

if [[ -z "$existing_id" ]]; then
  log "Creating user ${MCP_ADMIN_USER}"
  payload=$(jq -n \
    --arg u "$MCP_ADMIN_USER" \
    --arg p "$MCP_ADMIN_PASSWORD" \
    '{username:$u, userpassword:$p, mail:["\($u)@local.test"], givenName:["MCP"], sn:["Admin"], cn:["MCP Admin"]}')
  resp=$(curl -sk -w '\n%{http_code}' -X POST \
    "${REALM_BASE}/users?_action=create" \
    "${auth_hdr[@]}" \
    -H "Content-Type: application/json" \
    -d "$payload")
  body=$(echo "$resp" | sed '$d')
  code=$(echo "$resp" | tail -1)
  if [[ "$code" != "201" && "$code" != "200" ]]; then
    err "create failed (HTTP $code): $body"
    exit 1
  fi
  existing_id=$(echo "$body" | jq -r '._id')
  ok "user created with _id=${existing_id}"
else
  warn "user exists (_id=${existing_id}) — resetting password"
  curl -sk -X POST \
    "${REALM_BASE}/users/${existing_id}?_action=changePassword" \
    "${auth_hdr[@]}" -H "Content-Type: application/json" \
    -d "$(jq -n --arg p "$MCP_ADMIN_PASSWORD" '{userpassword:$p}')" >/dev/null
  ok "password reset"
fi

# 3. Add to the ui-realm-admin privileged group.
# AM's group membership API takes the user's UUID, not username.
log "Granting ${MCP_ADMIN_PRIVILEGE} on realm ${AM_REALM}"
curl -sk -X POST \
  "${REALM_BASE}/groups/${MCP_ADMIN_PRIVILEGE}?_action=addMember" \
  "${auth_hdr[@]}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg u "$existing_id" '{uid:$u}')" >/dev/null || \
  warn "group addMember returned non-zero (may already be a member)"

ok "bootstrap complete"
cat <<EOF

  MCP admin credentials (store these in mcp-server/.env later):
    AM_BASE_URL=${AM_BASE}
    AM_REALM=${AM_REALM}
    AM_ADMIN_USER=${MCP_ADMIN_USER}
    AM_ADMIN_PASSWORD=${MCP_ADMIN_PASSWORD}
EOF
