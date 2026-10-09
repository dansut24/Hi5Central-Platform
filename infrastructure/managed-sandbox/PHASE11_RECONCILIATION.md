# Phase 11 — Legacy UAT/Test reconciliation and cutover gate

**Status: inventoried read-only, activation/cutover blocked.** Nothing in this
directory starts/stops workloads, exports sensitive records, rotates passwords,
changes DNS/TLS, deletes volumes, or touches Dev/Production.

## VPS findings (9 October 2026)

| Finding | Legacy UAT | Legacy Test |
|---|---|---|
| Compose project | `hi5central-uat` | `hi5central-test` |
| Deployment mode | managed, **single** tenant | managed, **single** tenant |
| Application build | Earlier separate images | Earlier separate images |
| API target | `uat-api.hi5central.com` | `test-api.hi5central.com` |
| Workspace route | `uat.hi5central.com` | `test.hi5central.com` |
| RMM + TURN components | Present; not sandbox-qualified | Present; not sandbox-qualified |
| PostgreSQL + Redis | Distinct Compose volumes | Distinct Compose volumes |
| Legacy gateway | Connected to `hi5central` shared edge | Connected to `hi5central` shared edge |
| Approximate PostgreSQL size | 178 MB | 174 MB |
| Tenant / user / membership / session rows | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

These counts are **not an assertion of empty databases**. Other application
tables, agent artifacts, software catalogues, Redis keys, configuration volumes
and TURN/gateway data were *not* inventoried for removal.

The VPS shared legacy edge network currently also contains database/cache
containers. **New pilot DB/Redis must never join it.** Both legacy API hostnames
already have owners, so a customer pilot **must not repoint them** as an
unreviewed shortcut. Both canonical UAT/Test API and example customer suffix
hostnames resolve in DNS, but no end-to-end verification of TLS, wildcard
routing, HTTP host selection or reverse proxy fallback is complete. The
legacy gateway Caddyfiles show `http://` listener routes and locally mapped
ports, so a separate TLS-termination review is required.

Only an older Test-labelled PostgreSQL snapshot was found by the limited
`/workspace/backups` filename scan. This is **not** a current backup audit.
Before any decommissioning, record fresh backup evidence and a verified
restore to an independent scratch environment; include Postgres, Redis,
installer/download/config volumes, routes, TLS state, rotation keys and any
device/automation data in scope. Never copy real customer credentials,
sessions, MFA methods, devices or tickets into a pilot sandbox.

## Coexistence recommendation

1. **Preserve** the existing `hi5central-uat` and `hi5central-test` projects
   and their persistent volumes unchanged while ownership and backup evidence
   are reviewed.
2. Stage the new **multi-tenant** projects under distinct names
   `hi5-sandbox-uat` and `hi5-sandbox-test` only after explicit infrastructure
   approval. Use distinct, internal Postgres/Redis networks, credentials,
   volumes and dedicated edge networks. No RMM, Admin, TURN, background jobs or
   host-published ports. Keep new tenants suspended.
3. For a *future* parallel API pilot, use **unpublished**
   `pilot-uat-api.hi5central.com` and `pilot-test-api.hi5central.com`.
   Configure `SANDBOX_ROUTE_CHANNEL=parallel` and the matching
   `API_URL`. The browser workspace still needs an individually reviewed
   customer-qualified `*uat` or `*test` hostname, confirmed not to route to
   Production through any wildcard. Resolving DNS alone is insufficient.
4. Independently check gateway network attachments, explicit Caddy hostname
   matches, DNS owner/target/TTL, TLS certificate SAN/issuer/renewal, CORS and
   cookies, Host-header forwarding, fallback behaviour and two-person
   activation approvals. Only then publish a narrowly approved host route.
5. Verify synthetic first-owner invite/MFA, tenant isolation, forbidden RMM
   routes, suspension and rollback against the new runtime. Production and
   legacy URLs must stay stable throughout.
6. After the owner signs off and current, restored backups are verified,
   choose **coexist**, **migrate selectively**, or **retire**. Retiring a
   legacy service requires separate explicit authorization, a change window,
   monitoring, rollback method and inventory of all attached resources.

**Never automatically delete any legacy project/volume or repoint a canonical
API hostname.** Do not infer authorization from an empty `tenants` table,
a green build or a passing static preflight.

## Read-only operator checks

From the monorepo directory on a host with authorised local Docker access:

```sh
node infrastructure/managed-sandbox/inventory-legacy.mjs --read-only
node infrastructure/managed-sandbox/plan-routes.mjs \
  --environment uat --tenant pilotexample --channel parallel
node infrastructure/managed-sandbox/plan-routes.mjs \
  --environment test --tenant pilotexample --channel parallel
```

The inventory command reads Docker Compose labels, container status,
**only** tenancy/runtime identifiers, network names, published port metadata,
volume **names**, gateway hostnames/proxy targets and shared-edge member names.
It does not read credential values, database rows, files in persistent volumes
or TLS private keys. Output is a redacted, non-secret report; review and store
it under the organisation's normal infrastructure evidence policy. The
reconciler **always** leaves `pilotActivationAllowed`,
`routeChangesAllowed` and `legacyRemovalAllowed` set to false.

## Mandatory sign-off before any pilot

- Legacy UAT/Test service ownership and data retention classified
- Backups current, retained separately, test-restored and rollback timed
- Approved immutable release images and unique UAT/Test keys recorded
- Isolated database/Redis and network membership independently verified
- Alternate hostnames' DNS/TLS and gateway conflicts independently reviewed
- No production wildcard fallback or credential/session crossover
- Independent authenticated operator approval, audit trail and change window
- Customer never activated without first-owner MFA and suspension drill
