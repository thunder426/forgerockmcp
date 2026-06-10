.PHONY: help install preflight up bootstrap token smoke down destroy logs ps passwords node-catalog

help:
	@echo 'Targets (run from ops/):'
	@echo '  make install    - brew-install every required CLI + OrbStack'
	@echo '  make preflight  - check required CLIs and /etc/hosts'
	@echo '  make up         - start Minikube + install ForgeOps platform'
	@echo '  make bootstrap  - create mcp-admin user; write AM_ADMIN_PASSWORD into mcp-server/env/.env'
	@echo '  make token      - generate MCP shared secret; write to mcp-server/env/.env AND agent/env/.env'
	@echo '  make smoke      - verify AM + IDM are responding'
	@echo '  make node-catalog - regenerate agent/skills/_references/am-node-catalog.json from the live AM'
	@echo '  make passwords  - print generated amadmin / openidm-admin passwords'
	@echo '  make ps         - kubectl get pods in the namespace'
	@echo '  make logs       - tail AM pod logs'
	@echo '  make down       - delete the namespace (keeps Minikube)'
	@echo '  make destroy    - delete the Minikube profile entirely'

install:   ; @scripts/install-deps.sh
preflight: ; @scripts/preflight.sh
up:        ; @scripts/up.sh
bootstrap: ; @scripts/bootstrap-mcp-admin.sh
token:     ; @scripts/gen-token.sh
smoke:     ; @scripts/smoke.sh
node-catalog: ; @scripts/dump-node-catalog.sh
down:      ; @scripts/down.sh
destroy:   ; @scripts/destroy.sh

ps:
	@kubectl get pods -n $$(grep ^NAMESPACE env/.env | cut -d= -f2)

logs:
	@kubectl logs -n $$(grep ^NAMESPACE env/.env | cut -d= -f2) -l app.kubernetes.io/name=am -f --tail=200

passwords:
	@ns=$$(grep ^NAMESPACE env/.env | cut -d= -f2); \
	echo "amadmin:        $$(kubectl get secret am-env-secrets  -n $$ns -o jsonpath='{.data.AM_PASSWORDS_AMADMIN_CLEAR}' | base64 -d)"; \
	echo "openidm-admin:  $$(kubectl get secret idm-env-secrets -n $$ns -o jsonpath='{.data.OPENIDM_ADMIN_PASSWORD}'    | base64 -d)"
