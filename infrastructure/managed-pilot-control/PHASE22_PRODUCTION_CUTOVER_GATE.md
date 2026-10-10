# Phase 22 — Public Admin cutover compatibility gate

**Observed 10 October 2026. Production has NOT been upgraded.**

## Verified outcome

The live `admin.hi5central.com` routes to the older
`hi5central-prod-admin` image, backed by the older
`hi5central-api` control-server image. Those images share the
`hi5central` Docker network and Production PostgreSQL with the
ITSM/RMM services and their live agent/remote activity.
The Production Compose project is `deployment` using
`/workspace/deployment/compose.runtime.yml`.

Production database `hi5central` read-only inventory before rehearsal:

| Invariant | Baseline |
| --- | ---: |
| Live database size | 377 MB |
| Existing customer tenant records | 4 |
| Existing owner memberships | 3 |
| Existing user records | 9 |
| Applied migrations | 124 |
| Environment provisioning queue table | Missing |
| Initial owner onboarding table | Missing |

The four tenant slugs currently registered are
`testcustomer`, `test2`, `contoso`, and `bobs-comp`.
`bobs-comp` has no owner; the other three have one owner membership each.
**Preserve all four**; do not reinterpret the Admin list as deployed workspaces.

### Real Production-snapshot migration rehearsal: PASS

Against the actual VPS, we streamed a transactionally consistent PostgreSQL
custom-format snapshot **directly between Docker containers** to a separate
PostgreSQL 17 instance on its own Docker-internal bridge.
The shadow container had no published ports and newly generated private
credentials. No customer rows were written into a host-side snapshot file
or CI artifact.

The identical immutable, checked API image
`ghcr.io/dansut24/hi5central-platform-api:sha-2d332d3e281a0048681062eab9a28d6b41721d36`
then applied all outstanding migrations **only to the shadow clone**.

Results after migration:

| Invariant | Before | Migrated shadow |
| --- | ---: | ---: |
| Tenants | 4 | 4 |
| Owner memberships | 3 | 3 |
| Users | 9 | 9 |
| Applied migrations | 124 | 149 |
| Provision queue schema | No | Yes |
| Owner onboarding schema | No | Yes |

Exit marker: `PHASE22_PROD_SNAPSHOT_MIGRATION_REHEARSAL=PASS`.

### Upgraded API compatibility against existing data: PASS

A second full shadow migration rehearsal also launched a **network-isolated
API and Redis pair** using the new immutable API image, an ephemeral database,
new test-only cryptographic keys, and background workers disabled.
It created only one **synthetic shadow-only** MFA-verified Admin session to
exercise authenticated read paths; that synthetic identity was removed.

- `GET /api/platform/v1/tenants` returned HTTP 200 with 4 existing tenants;
- 3 owner accounts were correctly represented by the upgraded API;
- missing-first-owner `POST /api/platform/v1/tenants` was rejected HTTP 400;
- the snapshot's tenant count remained 4, with no accidental customer writes;
- the full database, synthetic API, Redis, credentials and network were
  removed on completion.

Exit marker: `PHASE22_UPGRADED_API_PROD_SHADOW: PASS`.

The unmodified, live Production database still showed
**4 tenants / 3 owners / 9 users / 124 migrations** after both exercises.
No Production migrations, Admin/API swaps, DNS changes, agent jobs or
customer invitations were performed.

## Reproduce the rehearsal (authorised VPS only)

The reviewed scripts reside at
`infrastructure/managed-pilot-control/phase22-shadow/`.
They require Docker CLI access to the exact production
`hi5central-postgres` (read-only pg_dump) and the immutable API image,
and internally perform temporary isolated PostgreSQL/Redis/API tests.

Run only after an authorised maintenance/change review:

```sh
HI5_PRODUCTION_SHADOW_REHEARSAL=YES_READ_ONLY_SOURCE_EPHEMERAL_CLONE \
  sh infrastructure/managed-pilot-control/phase22-shadow/phase22-shadow-rehearsal.sh
```

The script refuses preexisting scratch names, creates new credentials
under mode 0600, never exposes a host port, verifies migration and
authenticated tenant reads, and automatically stops/removes scratch
containers and networks. No secrets or personally identifying tenant
records should appear in logs; only counts and pass/fail markers.
**Never run the script from an untrusted machine or on Production
database names other than those explicitly verified.**

The script snapshots real Production customer data into a transient
private clone while running. Treat the VPS operator role as privileged
during its execution, verify the clone is removed, and keep the console
and log access restricted.

## Public cutover gates still open

A successful migration and read-only Admin API rehearsal do **not**
prove safety for the rest of the shared Production API. Before the
public-facing upgrade, require all of the following:

1. **Encrypted off-host Production backup and verified off-host restore**
   of PostgreSQL plus a documented Redis state/session strategy. The
   private pilot has only had a local backup/restore test so far.
2. **Inventory the exact public Caddy/ingress ownership, TLS certificates,
   production Compose image pins and rollback file.** Preserve
   `admin.hi5central.com` and `api.hi5central.com` until the new
   gateway targets are verified on a non-public, allowlisted canary.
3. **Shared API compatibility regression**, especially existing Dev/Prod
   ITSM and Self Service login/MFA, RMM device check-ins, policies, software
   qualification, patch jobs, session cookies and viewer remote signalling.
   Updating a shared API to fix Admin must never silently break agents.
4. **Platform Admin identity/MFA migration strategy** for existing
   administrators and one validated first-owner invitation. Password-only
   fallback must not become a backdoor after enabling mandatory MFA.
5. **Signed operator/reviewer/executor activation identities, audited SMTP
   and the isolated UAT/Production provisioning executor.** A queued UAT
   request is not a deployed UAT; there is no safe unattended worker yet.
6. **Customer-specific configuration promotion** must produce a reviewable,
   typed allowlisted diff and transactional apply/rollback to that
   customer's Production database. The existing platform-wide release
   controls must not be used as a substitute.
7. **Explicit release authorisation** for the public Admin/API swap,
   including outage window, abort criterion, live smoke checks, revert
   image pins and restore procedure. Rollback cannot rely on reverting
   application images when new database migrations are not reversible.

Until those conditions are met, retain the current Production Admin/API
and continue testing in the isolated private pilot. Do not promise that
creating a tenant on the public site will immediately deliver a usable
workspace without the actual provisioning and customer-owner invitation.

## Remaining user-facing end-to-end pilot

With the initial pilot administrator's verified email, independently
approved key custody and restricted SMTP/TLS, open the approved pilot
Admin browser session, create one **Custom** customer, observe the
automatic UAT queue, provision isolated UAT, redeem the first-owner
invitation, run the wizard and then safely test a customer-specific
configuration change and UAT → Production approval. No real customer
Prod promotion should be performed before the separate configuration
apply/rollback implementation is validated.
