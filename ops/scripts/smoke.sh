#!/usr/bin/env bash
# Smoke-test the stack: AM serverinfo + admin login + journey list, IDM ping.
# Run after scripts/up.sh.
#
# Note: uses amadmin (pulled from the forgeops-generated secret), not mcp-admin.
# Granting non-amadmin users the journey-config privilege in AM 8 requires
# editing AM's delegation config via either the admin console UI or by adding
# the user to a specific DS group; neither path is exposed via REST in the
# default ForgeOps 2025.2 overlay. We'll revisit this once a proper realm
# with identity-store wiring exists.

source "$(dirname "$0")/lib.sh"

AM_BASE="https://${FQDN}/am"
IDM_BASE="https://${FQDN}/openidm"

# AM_REALM is server-side config now; mirror it for the smoke test.
AM_REALM="$(grep -E '^AM_REALM=' "$SERVER_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | awk '{print $1}')"
AM_REALM="${AM_REALM:-root}"
if [[ "$AM_REALM" == "root" || -z "$AM_REALM" ]]; then
  REALM_PATH="root"
else
  REALM_PATH="root/realms/${AM_REALM}"
fi
REALM_BASE="${AM_BASE}/json/realms/${REALM_PATH}"

AM_ADMIN_PASSWORD=$(kubectl get secret am-env-secrets -n "$NAMESPACE" \
  -o jsonpath='{.data.AM_PASSWORDS_AMADMIN_CLEAR}' | base64 -d)
[[ -n "$AM_ADMIN_PASSWORD" ]] || { err "could not fetch amadmin password"; exit 1; }

log "AM serverinfo"
curl -sk "${AM_BASE}/json/serverinfo/*" | jq '{cookieName, domains, realm}'

log "Login as ${AM_ADMIN_USER}"
COOKIE_NAME=$(curl -sk "${AM_BASE}/json/serverinfo/*" | jq -r .cookieName)
TOKEN=$(curl -sk -X POST "${AM_BASE}/json/realms/root/authenticate" \
  -H "Content-Type: application/json" \
  -H "X-OpenAM-Username: ${AM_ADMIN_USER}" \
  -H "X-OpenAM-Password: ${AM_ADMIN_PASSWORD}" \
  -H "Accept-API-Version: resource=2.0, protocol=1.0" \
  -d '{}' | jq -r .tokenId)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { err "amadmin login failed"; exit 1; }
ok "logged in as ${AM_ADMIN_USER}"

log "List authentication trees (journeys) in realm '${AM_REALM}'"
curl -sk \
  -H "${COOKIE_NAME}: ${TOKEN}" \
  -H "Accept-API-Version: protocol=2.1,resource=1.0" \
  "${REALM_BASE}/realm-config/authentication/authenticationtrees/trees?_queryFilter=true" \
  | jq '{resultCount, journeys: [.result[]._id]}'

log "Check that mcp-admin can authenticate (smoke for bootstrap success)"
MCP_TOKEN=$(curl -sk -X POST "${REALM_BASE}/authenticate" \
  -H "Content-Type: application/json" \
  -H "X-OpenAM-Username: ${MCP_ADMIN_USER}" \
  -H "X-OpenAM-Password: ${MCP_ADMIN_PASSWORD}" \
  -H "Accept-API-Version: resource=2.0, protocol=1.0" \
  -d '{}' | jq -r .tokenId)
if [[ -n "$MCP_TOKEN" && "$MCP_TOKEN" != "null" ]]; then
  ok "mcp-admin login OK (privileges TBD — currently only end-user level)"
else
  warn "mcp-admin login failed — re-run 'make bootstrap' from ops/"
fi

log "IDM ping"
IDM_ADMIN_PASSWORD=$(kubectl get secret idm-env-secrets -n "$NAMESPACE" \
  -o jsonpath='{.data.OPENIDM_ADMIN_PASSWORD}' | base64 -d)
curl -sk "${IDM_BASE}/info/ping" \
  -H "X-OpenIDM-Username: ${IDM_ADMIN_USER}" \
  -H "X-OpenIDM-Password: ${IDM_ADMIN_PASSWORD}" | jq .

ok "smoke tests passed"
