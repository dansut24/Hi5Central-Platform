# Phase 12 — Empty pilot edge preparation and public ingress audit

**State: two empty, internal pilot networks prepared. Customer access, gateway
attachments, DNS/TLS changes, synthetic user runtime, and customer pilot are NOT
activated.**

## Verified VPS changes — 9 October 2026

Two new dedicated Docker bridges were created on the existing VPS using
`prepare-empty-edges.mjs --apply --confirm PREPARE_EMPTY_PILOT_NETWORKS`:

| Bridge | Driver | Internal | Attachable | Connected containers |
| --- | --- | --- | --- | --- |
| `hi5central-sandbox-uat-edge` | bridge | true | false | 0 |
| `hi5central-sandbox-test-edge` | bridge | true | false | 0 |

Both networks have `com.hi5central.scope=managed-customer-pilot`,
`com.hi5central.lifecycle=phase12-network-only`, and a matching
`com.hi5central.environment` label.

Pre/post counts of the pre-existing shared Dev/UAT/Test networks were
unchanged: `hi5central=15`, `hi5central-dev_hi5internal=8`,
`hi5central-uat_hi5internal=8`, `hi5central-test_hi5internal=8`.
Neither Production nor any legacy Compose resource was restarted, detached,
or modified.

A transient network probe started two **unprivileged, no-volume, no-port**
Node listeners — one on each new bridge — then confirmed that same-container
TCP connected and cross-environment TCP connections failed in both directions.
The test removed both probe containers and rechecked that both networks were
empty. This provides point-in-time Docker bridge separation evidence, **not**
proof of independently isolated VPS hosts, service credentials or external
routing.

**Important:** both dedicated edge networks have `Internal=true`, preventing
ordinary public egress. The future sandbox API must not silently connect to
Live Redis, SMTP, update or RMM endpoints. A separately approved email delivery
proxy or scoped outbound relay must be designed before invitation emails can
work; do NOT bypass isolation by joining the Production network.

## Public DNS/TLS findings — release blocking

A credential-free read-only DNS/HTTPS probe found:

- Canonical legacy API hosts `uat-api.hi5central.com` and
  `test-api.hi5central.com` respond with HTTP 200 API JSON and describe
  legacy managed **single-tenant** runtimes. They remain reserved for legacy
  services; no reassignment is authorised.
- Both unpublished pilot API hostnames and unapproved sample customer
  suffix hostnames resolve to `213.171.194.229` and return a valid
  `*.hi5central.com` wildcard certificate.
- `HEAD /live` on `pilot-uat-api.hi5central.com`,
  `pilot-test-api.hi5central.com`, `pilotexampleuat.hi5central.com`
  and `pilotexampletest.hi5central.com` returns HTTP **200** despite no
  approved pilot routes.
- A read-only `GET /api/v1/system/deployment` on those four unpublished
  hosts returned **generic HTML**, not the Production API's JSON; therefore
  evidence does **not** establish a Production-API data leak. It **does**
  establish that unknown customer/pilot hosts are not yet failed closed.

**Blocker:** Do not publish customer UAT/Test routes until the authoritative
public ingress explicitly returns **404 or 421** (or another verified denial)
for all unapproved customer-qualified `*uat`/`*test` hosts, and the
approved pilot hosts alone route to the intended environment. DNS and wildcard
TLS presence **cannot** establish host authorisation. An independent reviewer
must inspect current edge routing, TLS certificate renewal, exact Host/SNI
selection, wildcard priority, CORS, cookies and negative-case behaviour from
outside the VPS before authorising any customer session.

## Repeatable commands

From an authorised checkout on the VPS:

```sh
node infrastructure/managed-sandbox/prepare-empty-edges.mjs --check
node infrastructure/managed-sandbox/public-route-audit.mjs --read-only
```

The second command performs credential-free public DNS lookups and TLS-verified
HTTPS HEAD requests; it does not alter DNS, Caddy or app services. Its report
**always** sets `approvalAllowed=false`; even a clean route report is only
one item of independent pilot approval evidence.

The following commands **modify only empty diagnostic infrastructure**, and
require deliberate operator execution. They must not be run against a
Production or shared network, and must not be placed inside CI as live VPS
mutation:

```sh
# Only if missing; idempotent and refuses unknown/pre-populated networks:
node infrastructure/managed-sandbox/prepare-empty-edges.mjs \
  --apply --confirm PREPARE_EMPTY_PILOT_NETWORKS

# Temporarily run isolated, no-port Node listeners, then remove them:
node infrastructure/managed-sandbox/probe-edge-isolation.mjs \
  --probe --confirm EPHEMERAL_CONTAINERS_ONLY
```

The network probe uses a local copy of
`ghcr.io/dansut24/hi5central-platform-api:dev` with
`--pull never`; it executes a short Node TCP listener, never the API
application, and never receives secrets. For higher-assurance evidence,
repeat network tests using fixed verified image digests and monitor Docker
firewall rules. The user-facing app, Agent and RMM have not been tested against
a real isolated pilot here.

## What is still blocked

1. Operator review of the authoritative gateway; explicit deny routes for
   unapproved `*uat`/`*test` and independent DNS/TLS verification.
2. A signed, immutable matching API/frontend release, environment-specific
   secrets, SMTP relay, Redis/database identity attestations and isolation.
3. Synthetic suspended customer preparation, email invitation and TOTP MFA
   enrolment in separate, operator-approved UAT/Test runtimes.
4. Browser tests on truly isolated, explicitly authorised hostnames:
   normal login, MFA, customer-to-customer isolation, tenant reactivation,
   session revocation, no Agent/TURN exposure, and no Production fallback.
5. A timed rollback, independent authenticated human approvals, monitored pilot
   acceptance criteria and evidence retention.

**No tenant approvals, customer invitations, customer containers or public
gateway connections were created in Phase 12.** The prepared networks remain
empty and are NOT a readiness authorisation.

## Follow-up: public ingress denial fixed (9 October 2026)

The HTTP 200 wildcard fallback described above has now been corrected **in the
active, persistent public Caddyfile**. The original observations are retained
as historical audit evidence. Hostname-specific routes for unapproved UAT/Test
and all `pilot-*` names return HTTP 404; otherwise unmatched HTTPS virtual
hosts (including trailing-dot Host headers) return HTTP 421. Case-insensitive
host matching prevents mixed-case bypasses. A separate default HTTPS route
handles names that Caddy's wildcard host matcher does not select.

The latest deployment included automatic rollback on any regression;
**49 of 49 public HTTP checks passed**, and the independent Phase 12 public
DNS/TLS audit returned **zero findings** (pilot approval stays false).
Production applications, Dev, and legacy UAT/Test routes remained healthy;
no customer containers, users, DNS records or pilot gateway connections were
created. The deployed public gateway was reloaded in place without restart.

The exact production file was backed up on the VPS before changes:
`/opt/hi5central/deployment/Caddyfile.pre-phase13-20261009T224240Z`.
A second working-config backup exists for the hardening/catchall change:
`/opt/hi5central/deployment/Caddyfile.pre-phase13-complete-20261009T224913Z`.

See `PUBLIC_INGRESS_FIX.md` for details, rollback and source-controlled
patterns. The original requirement for independently approved customer DNS/TLS,
separate runtime/database/Redis attestation, MFA and browser tests remains.
