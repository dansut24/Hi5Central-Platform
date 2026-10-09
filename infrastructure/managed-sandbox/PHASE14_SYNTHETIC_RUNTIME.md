# Phase 14 — disposable UAT/Test runtime validation

**Status: synthetic private API + ITSM/Portal smoke PASSED; no customer pilot activated.**

This phase verifies **real published images** with temporary data and real
private Docker networking, but does **not** create a long-lived UAT/Test
runtime, publish DNS/TLS, enrol a customer or approve Production access.

## Results from VPS (10 October 2026)

The 2026-10-09/10 smoke ran against matching published
`ghcr.io/dansut24/hi5central-platform-{api,itsm}:dev` image labels
(`a015fc133a49462cf8376e2835d1a89739157d15`). For each environment,
a dedicated throwaway **internal** Docker bridge was created, with:

- New independent PostgreSQL 17 and password-protected Redis 8 containers,
  randomly generated **different credentials**, and **no host port mappings
  or Docker volumes** (database state existed only in the disposable writable
  container layer).
- All application SQL migrations, applied only to the scratch database.
- A deliberate API startup attempt before any database attestation:
  **startup rejected; no listener**.
- A deliberate second attempt after a **synthetic**, test-only database
  identity but before Redis binding: **startup rejected; no listener**.
- A synthetic Redis identity bound to the same scratch database UUID.
  Only after both attestations was the private UAT/Test API permitted to run.
- Live HTTP `/live` and `/health` passed in both environments;
  deployment metadata reported managed/multi-tenant and correct UAT/Test
  identities, with background workers disabled.
- `/api/v1/rmm/*` and `/api/v1/connect/*` returned HTTP **423**.
  Unauthenticated `/api/v1/auth/session` returned HTTP **401**.
  There were **zero tenants** in each scratch database.
- The matching ITSM/Portal image served its homepage and health endpoint.
  Its `runtime-config.js` was inspected for the exact sandbox API,
  `TENANCY_MODE=multi`, correct environment and **no Admin, RMM or default
  demo tenant**. The tested frontend runtime entrypoint was copied from
  corrected `develop` source into the *unstarted disposable container*,
  because the previously built ITSM image still had the old default.
- UAT could not connect to Test PostgreSQL, and Test could not connect to
  UAT PostgreSQL by internal container IP.

Result: **`PHASE14_SYNTHETIC_RUNTIME_SMOKE: PASS`**. The script removed
all temporary API, frontend, PostgreSQL, Redis and probe containers and
both temporary private bridges. The intentionally prepared *empty* pilot
edge networks remained untouched. Existing engineering Dev, legacy UAT/Test
and Production services stayed running.

### Startup defects found and fixed in develop

1. The bundled Remote Connect module required
   `CONNECT_CODE_HMAC_KEY` even when managed UAT/Test policy disabled all
   Connect routes and WebSocket listeners. Fixed in
   `services/api/src/rmmConnect.js` using
   `requiresConnectCodeHmacKey()` from the pure sandbox policy.
   The smoke supplied a disposable compatibility key only because its
   **currently published** API image predated this fix.
2. The ITSM runtime-config generator substituted `demo-tenant` for empty
   `PRIMARY_TENANT_SLUG` in managed UAT/Test. Fixed in
   `apps/itsm/deployment/runtime-config-entrypoint.sh`, with regression
   checks for UAT, Test and legacy unaffected modes.
3. Both browser and API deployment config readers could fallback to
   `https://admin.hi5central.com` in isolated managed UAT/Test.
   They now explicitly return an empty Admin URL for those runtimes.

All three application changes **require a new built/published image** and
a repeat run against those exact matching release digests before a real
pilot can be contemplated. The temporary frontend entrypoint override used
for validation must *not* be used in permanent installations.

## Repeating the synthetic test (deliberate, local-only action)

On an authorised Docker test host with matching API/ITSM images, PostgreSQL
17 and Redis 8 images available locally:

```sh
HI5_PHASE14_SMOKE=1 node \
  infrastructure/managed-sandbox/synthetic-runtime-smoke.mjs \
  --run --confirm EPHEMERAL_SYNTHETIC_ONLY
```

This uses `--pull never`, compares the API/ITSM image revision labels, and
generates distinct networks named `hi5-p14-scratch-uat-*` and
`hi5-p14-scratch-test-*`. No production resources or credentials are read.
The runtime never attaches to `hi5central`, the prepared pilot edge bridges,
or any existing database/Redis network. The script does not call
`docker compose up` or create DNS/TLS routes.

**Exception for verifying a *source-only* frontend entrypoint correction
against an older published image**: set
`HI5_PHASE14_ITSM_ENTRYPOINT=/tmp/hi5-phase14/.../runtime-config-entrypoint.sh`
to an actual executable test copy of the corrected script. It is copied
into the unstarted disposable frontend container before launching.
For the published pre-fix API image **only**, also set
`HI5_PHASE14_ALLOW_OLD_IMAGE=1` to supply a disposable Connect HMAC
compatibility key and recognise its legacy Admin URL. The default is
`HI5_PHASE14_ALLOW_OLD_IMAGE=0`; this is intentional, so all new images
must pass **without** unnecessary Connect credentials or a Production
Admin URL.

These overrides are strictly for smoke test diagnostics and must both be
removed once the new API and ITSM images are green.

The smoke cleanup runs under a `finally` block and verifies scratch networks
were deleted. Independently inspect resource names after any host interruption
or forced process termination; the script cannot clean up if forcibly killed
outside its normal lifecycle.

## Still required before customer access

- Green CI and a matching rebuilt API/ITSM image, followed by repeat smoke
  **without** frontend override and throwaway Connect compatibility workaround.
- Operator-reviewed long-lived private UAT/Test runtime provisioning, distinct
  backup and secret storage, independently verified PostgreSQL/Redis
  attestations and approved least-privilege SMTP egress.
- Explicitly approved, environment-qualified public DNS/TLS host routes and
  gateway network attachment, followed by negative-route verification.
- Browser E2E with a **synthetic owner**, one-time invitation, strong password,
  MFA enrolment/challenge, team RBAC, tenant switching denial, session
  revocation, and no RMM/Agent/Remote Connect exposure.
- Two authenticated human approvals, time-boxed rollout/rollback and audit
  retention. Synthetic attestation in this script is **not** those approvals.

**No customer invitation, approval, Production data migration or public
sandbox activation was performed by this phase.**
