# Managed customer UAT/Test — Phase 10 infrastructure blueprint

**State: configuration prototype only. No customer activation or DNS changes are authorised.**

This directory defines a **separate Compose project for each environment**:
`hi5-sandbox-uat` and `hi5-sandbox-test`. Each has its own PostgreSQL
database service and named storage, password-protected Redis and named storage,
migration runner, API and ITSM frontend. Postgres/Redis use a Docker network
marked `internal: true` and have **no host port mappings**. The API and
frontend connect to that private network (API only) and their environment's
dedicated gateway-facing edge network:

- UAT: `hi5central-sandbox-uat-edge`
- Test: `hi5central-sandbox-test-edge`

The trusted reverse proxy must explicitly attach to an approved environment's
edge network. The two edge networks must never be joined to each other and
must not grant access to Dev/Production application internals. Inspect Docker
network memberships and firewall rules separately: a valid Compose model is
**not** proof of physical or operational isolation.

## Preflight only — no customer data

1. On an isolated operator workstation, create two separate, access-restricted
   working directories with a copy of `compose.yml`, `preflight.mjs`
   and `validate.mjs`. Copy `runtime.env.example` to `runtime.env` in
   each working directory; configure one `uat` and one `test`.
2. Generate **distinct** database names, usernames, cryptographic secrets,
   and encryption keys for UAT and Test. Record them in approved secrets
   management, not a repository. URL-encode password characters inside
   `DATABASE_URL` and `REDIS_URL`. Set `chmod 600 runtime.env`.
3. Use the exact approved OCI manifest digests for all four images
   (Postgres, Redis, API, ITSM). The API and ITSM images must both be from the
   same reviewed release revision; a digest alone does not prove this.
4. Use `https://uat-api.hi5central.com` or
   `https://test-api.hi5central.com`. Do **not** set
   `APP_URL`, `PORTAL_URL`, `ADMIN_URL`, `RMM_URL` or
   `COOKIE_DOMAIN`. Do **not** map sandbox API to the Live API.
   `BACKGROUND_WORKERS_ENABLED=false`; RMM remains locked.
5. From the UAT working directory, run:

   ```sh
   node preflight.mjs --peer-env /secure/test/runtime.env
   ```

   From Test, repeat with `--peer-env /secure/uat/runtime.env`.
   Preflight reads and compares both protected files, then runs a **read-only**
   `docker compose config --format json` topology inspection. It will not
   create networks, containers, tenants or public routes, or make any
   database or DNS changes. It does not print credentials.

   Both paths must refer to real secret files. The provided
   `runtime.env.example` deliberately contains placeholders and will fail.

## Subsequent work (requires independently recorded operator approval)

Do not use the following as a green light to activate customers. Before a
sandbox can be **started**, an independent reviewer must verify and record:

- Physical/logical separation of the PostgreSQL and Redis instances, database
  identity attestations, Redis ACLs/attestation write protection, backups,
  restoration paths, network reachability, outbound mail/integration controls.
- Unique API hostnames and certificate/TLS policy, DNS ownership, gateway
  routes **before** any wildcard Live routing, and **fail-closed handling of
  unapproved UAT/Test hostnames**. The file
  `pilot-routes.EXAMPLE.caddy` is intentionally commented out and is not
  automatically loaded.
- Separation of Dev, Test, UAT and Production sessions, MFA secrets and agent
  credentials; whether support personnel can reach only approved tenants.
- Operator identities attested using independently authenticated
  approvals, including approval/activation separation; signed release
  provenance, rollback, monitoring and audit retention.

Once those prerequisites are independently approved, an operator may use the
ordinary Compose lifecycle in the separately secured working directory
(`docker compose --env-file runtime.env -f compose.yml ...`), apply migrations,
write the independently attested UAT/Test DB and Redis identities, start the
sandbox API, and only **later** enable individually approved TLS hostnames.
Startup intentionally fails if required database or Redis attestation is absent.
Prepared customers stay suspended until their audited operator activation
process completes.

**Never** copy Production records, passwords, MFA methods, sessions, tokens,
RMM devices or automation jobs into UAT/Test. Use local suspended identities
and synthetic test data only. This blueprint omits RMM, TURN and Platform Admin
services deliberately. No pilot tenant or DNS record was created by this phase.

## VPS discovery — legacy UAT/Test stacks (read-only inspection)

The VPS already runs `hi5central-uat` and `hi5central-test` Compose
projects, using **managed, single-tenant** control-server builds from the
earlier deployment architecture. Both also contain RMM Web and TURN components.
These are **not** the managed multi-tenant, RMM-locked pilot runtimes described
here. Their gateway processes are attached to the existing shared
`hi5central` edge, with locally bound gateway ports and additional
TURN UDP port mappings.

**Deployment blocker:** do not reuse those legacy project names, data volumes,
Redis databases, session credentials, or gateway routes. Before a customer
pilot, inventory/retain required data, agree whether to retire or isolate the
legacy stacks, audit all current public gateway/wildcard routes, and verify
that no unapproved customer `*uat`/`*test` hostname resolves to Production.
The new project names and network aliases deliberately avoid the old stacks.
No existing container or route is modified by this blueprint.

## Read-only DNS/TLS gateway route planning

From a checked-out monorepo, generate a reviewed route plan without
modifying the gateway:

```sh
node infrastructure/managed-sandbox/plan-routes.mjs --environment uat --tenant acme
node infrastructure/managed-sandbox/plan-routes.mjs --environment test --tenant acme
```

The planner validates customer slug reservations, calculates the exact
workspace/Portal/API hostnames, dedicated proxy targets and expected edge
network, and sets `deploymentChanges`, `dnsChanges`, and `tlsChanges`
to `false`. It refuses Live/Dev and disallowed tenant names. This is a
route **plan**, not a deployed Caddyfile. An independently reviewed change must
install the exact routes after proving no conflict with legacy UAT/Test
gateways, no wildcard Production fallback, working TLS, and environment-local
API/session behaviour.

## Automated evidence

`node --test infrastructure/managed-sandbox/validate.test.mjs` runs
positive and negative topology/credential tests.

`HI5_PHASE10_SMOKE=true node infrastructure/managed-sandbox/test-compose.mjs`
generates fake UAT/Test credentials in disposable local folders, renders
both real Compose models and verifies unsafe settings are rejected. The folders
are deleted in `finally`, and the command never executes `up`, `run` or
`create`. The API build workflow runs both checks before publishing images.
