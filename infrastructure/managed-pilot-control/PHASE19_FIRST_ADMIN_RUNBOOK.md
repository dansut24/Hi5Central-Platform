# Phase 19 — First real Platform Administrator and pilot customer runbook

## Current result — 10 October 2026

**The code and private pilot deployment are ready for a controlled first-admin
invitation ceremony; the real customer pilot is NOT public or activated.**

The verified matching API/Admin revision is
`45aa3e182acf746329ffbcc82956d4f8d8307791`, installed only in the
separate `hi5central-pilot-control` Compose project. Migration
`142_pilot_admin_bootstrap.sql` completed; both API/Admin are healthy.
Production, Dev and legacy UAT/Test are unchanged.

The live private pilot database has:
- **0 users, 0 Platform Admins, 0 customer tenants, 0 invitations**;
- one UUID-scoped, *unapproved* pilot bootstrap reservation;
- **0 signed control-plane approval identities**.

The new `/api/platform/v1/auth/bootstrap/accept` rejects an unapproved
invitation with HTTP 423 and the wrong browser Origin with HTTP 403; Admin
sessions without MFA return HTTP 401. The four future pilot-control and
UAT/Test API hostnames still return HTTP 404 at public ingress, and the pilot
containers have **no published host ports**. This is an intentional release
blocker, not a failed deployment.

[Green Phase 19 disposable real-API lifecycle](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38033366468):
separate CI-only PostgreSQL, Redis, API and Admin containers; synthetic signed
trust assumed for setup, one-time token redeemed; mandatory TOTP, Admin
authorisation and logout proved; **all disposable containers and volumes
destroyed**. The unit suite separately verifies real Ed25519 signature
validation and role/tenant/scope mismatches. The synthetic CI database is
never the persistent VPS database. No real SMTP delivery or browser
interactive tests are claimed complete.

## 1. First administrator identity (external verified approval needed)

The customer/platform owner must provide an actual **pilot-only, verified
email address and name**. Do not infer them from GitHub, Dev, previous
credentials or account metadata; do not create an account with a default
password. Confirm the mailbox is under the intended person's control.
Record the independent operator and reviewer who are allowed to authorise
the first admin and their separate credential custody.

No approved email, operator signing credentials or SMTP relay has yet been
provided or provisioned.

## 2. Private control-plane inspection (read-only)

On the authorised VPS, inspect the exact private project before any mutation:

```sh
docker compose --env-file /workspace/phase17-pilot-control/runtime.env \
  -f /workspace/phase17-pilot-control/compose.yml ps
docker exec hi5central-pilot-control-postgres-1 \
  psql -U pilot_user_a -d hi5pilotcontrol -At -c \
  "SELECT scope_id FROM pilot_admin_bootstrap_scope WHERE singleton=true;"
docker exec hi5central-pilot-control-postgres-1 \
  psql -U pilot_user_a -d hi5pilotcontrol -At -c \
  "SELECT (SELECT COUNT(*) FROM users),(SELECT COUNT(*) FROM tenants),(SELECT COUNT(*) FROM platform_admin_members);"
```

Record the unique `scope_id` in the change ticket, not in a public chat.
The operator script supports `node services/api/scripts/pilot-admin-bootstrap.mjs
--check` when run from an authorised, isolated operator runtime with
`PILOT_CONTROL_DATABASE_URL` pointing to the **private**
`hi5pilotcontrol` database and the exact pilot deployment settings.
A passing check **does not** authorise issuance or public access.

## 3. Separately held signing keys and trust anchors

Use at least three registered distinct public-key identities in an approved
version-1 operator trust registry: an operator, an independent reviewer, and
an executor for later sandbox activation. This registry follows
`readOperatorTrustFile` (`id`, `keyId`, Ed25519 `publicKeyPem`,
`roles`). It must be mode 0600, stored outside Git/tenant data and
protected against unauthorised modification. The private Ed25519 keys
must remain on *separate* controlled operator workstations or suitable
hardware-backed custody; no signing private key belongs in a container,
email, database or repository.

The initial Admin bootstrap is an **`issue`** authorisation, distinct
from later tenant environment **`approve`** and **`activate`**
authorisations. The two operators separately run the offline signer from
the repository:

```sh
node services/api/scripts/pilot-admin-bootstrap-sign.mjs --sign
```

Each invocation uses these private workstation environment values:

| Variable | Purpose |
| --- | --- |
| `BOOTSTRAP_PRIVATE_KEY_FILE` | Mode-0600 owner's Ed25519 PKCS#8 signing key |
| `BOOTSTRAP_SIGNATURE_OUTPUT` | Fresh, exclusive-create, protected assertion file |
| `BOOTSTRAP_SIGNING_ROLE` | `operator` or `reviewer` |
| `BOOTSTRAP_SIGNING_OPERATOR_ID` | Independently registered human identifier |
| `BOOTSTRAP_SIGNING_KEY_ID` | Corresponding enrolled registry key ID |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME` | Exactly the independently verified invitee |
| `PILOT_CONTROL_SCOPE_ID` | Exactly the read-only private DB scope UUID |

Each signature is bound to this specific admin, database scope, action,
role, and a unique nonce and expires after **two minutes**. It is not a
permission to route DNS or activate tenants. The signer writes the JSON
assertion to a protected file and never prints signatures or keys.

## 4. Controlled SMTP invitation issuance

Before issuing any invitation, approve a **pilot-scoped SMTP relay** that
can deliver to only the verified admin mailbox. Do not attach the isolated
database or API to Production Redis, default email queues or RMM.
Use an operator-controlled runtime with network access to the private
PostgreSQL instance; never publish its port on the internet.

`services/api/scripts/pilot-admin-bootstrap.mjs --issue` requires:

- all of the `PILOT_ADMIN_BOOTSTRAP_ENABLED=true`,
  `PLATFORM_ADMIN_MFA_REQUIRED=true` managed-multi live pilot configuration
  and exact pilot API/Admin URLs;
- `PILOT_CONTROL_DATABASE_URL` for the exact restricted
  `pilot_user_a@hi5pilotcontrol` private database;
- `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME`;
- a separately provisioned `PILOT_OPERATOR_TRUST_FILE`;
- exact `PILOT_ADMIN_ACTOR_ASSERTION` and
  `PILOT_ADMIN_REVIEWER_ASSERTION` signed JSON;
- `CONFIRM_PILOT_ADMIN_BOOTSTRAP=<scope-id>:<email>:invite`;
- explicit scoped `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD` and `SMTP_FROM`.

Both signatures are checked **before any mutation**. The database must
have zero users, tenants and platform admins, and must match the
named `hi5pilotcontrol` database. Once approved, the command creates
an attested control-plane identity bound to the scope UUID, stores only
the invitation's SHA-256 token hash, and appends issuer/reviewer audit.
If SMTP delivery fails, it revokes the invitation and adds an audit event.
The invitation token never appears in operator CLI output or database.
The emailed link expires after **24 hours** and can be accepted once.

**Do not run this command merely because the user asks to proceed**:
identity verification, trusted keys, a real mailbox and approved SMTP
are necessary preconditions. A returned mail relay receipt does not
guarantee inbox delivery.

## 5. Private TLS/browser ceremony before public routing

To complete a first MFA enrolment before exposing Admin widely, establish
a separately reviewed **restricted ingress** to the exact origins
`https://pilot-admin.hi5central.com` and
`https://pilot-control-api.hi5central.com`, such as a verified
corporate VPN / private tunnel or a temporary IP-allowlisted reverse proxy
with correct certificates and Host/SNI. Do not substitute `http://`,
disable TLS certificate validation, use a wild-card Production fallback,
or bypass the Origin/cookie checks.

The first administrator opens the *emailed* link ending in
`/accept-admin-invitation`, sets a new strong password, and sees a
confirmation **without being logged in**. They then sign in normally,
enrol a TOTP authenticator and verify it. They must securely save ten
single-use recovery codes, sign out and sign in again. The test must
confirm no shared session with Dev, Production or other tenants.

Only after audit, browser, backup/restore, mail delivery and route-denial
review passes should public exact-host routes be approved separately.
`admin.hi5central.com` (legacy Production-facing destination) must
not be repointed during this parallel pilot.

## 6. Real pilot customer creation through Admin

From the authorised private pilot Admin session:

1. Open **Tenants → New tenant**, enter a new company name and available
   slug, leave RMM disabled initially, choose trial billing and ITSM +
   self-service. Create this as a new managed **control-plane reservation**,
   not by copying a Dev or Production tenant.
2. Request **Test** and **UAT** separately for this tenant. The current
   Admin API queues operator requests only; it does **not** create
   environments or DNS automatically.
3. A trusted operator claims each request, provisions isolated
   UAT/Test Postgres/Redis and proves independent DB/Redis identities,
   network separation, backup restore, no customer-data copy and signed
   first-owner approvals.
4. Sign independently reviewed `--approve` and `--activate`
   decisions using the existing `tenant-environment-activate.mjs`
   Ed25519 actor/reviewer workflow. Enable exact route/TLS names
   **only** after their own security and rollback approvals.
5. Issue the *customer's* first-owner UAT/Test email invitation using
   `tenant-environment-owner-invite.mjs`. Accept, enrol MFA, then test
   Owner/Admin/Analyst/Requester role boundaries, Portal access, records,
   approvals, notifications, session suspension, isolation, and reset.

**Production changes, agent/viewer deployments, config promotions and
Test resets require their own later milestones and are not silently
enabled as part of tenant creation.**

## Rollback, stop and safety

- Before first real invite, public pilot hostnames should return
  HTTP **404/421**; never point unknown UAT/Test suffixes to Production.
- If first Admin enrolment is unapproved or compromised, keep public
  routes disabled, revoke unused invitations through a separately
  authorised database/operational incident process, revoke Admin sessions
  and rotate exposed credentials. Avoid deleting append-only audit records.
- The initial private pilot already has a confirmed local schema backup
  and restore, but **off-host encrypted backup and restore testing**,
  key recovery and operator separation are still needed before broad access.
- Preserve `/workspace/phase17-pilot-control/runtime.env` mode 0600,
  retain the recorded image digest pins, and never copy those credentials
  into Git or chat.
