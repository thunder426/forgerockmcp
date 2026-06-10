# IDM config patches

The IDM pod's `/opt/openidm/conf` is an `emptyDir` populated from the IDM container image by an `fbc-init` init container. There is no kustomize overlay or ConfigMap mount that wins over the image. Live `kubectl cp` edits survive container restarts but are wiped on pod recreation (node reboot, image upgrade, `kubectl delete pod`).

The files here are the durable source for patches we need on top of the stock image. Apply them after `make up` with `apply.sh`.

## authentication.json

Adds a second `rsFilter.subjectMapping` entry so /alpha-issued OAuth2 access tokens resolve to `managed/user` records — same target as /root. This works because the AM /alpha identity store writes to the same `ou=people,ou=identities` container that IDM's `managed/user` reads from.

Without this patch, /alpha login succeeds but every `/openidm/*` call from the enduser UI returns 503 (`SecurityContextFilter: Rejecting invocation as required context to allow invocation not populated`).

Reapply after any pod recreation:

```sh
./apply.sh
```
