# Phase 24 — public-host signup visual canary (10 October 2026)

## Status: Visual preview on the real HTTPS host — NOT open signup

**URL:** https://hi5central.com/signup?preview=1

**Scope:** Only that exact `/signup?preview=1` request (not the
ordinary `/signup`) is proxied to an isolated, version-pinned,
static frontend. The two hashed frontend asset paths are also routed to
that frontend. All other marketing, API, Admin, ITSM and RMM routes are
unchanged. The preview currently uses the regular site's runtime config,
so requests to the new API path cannot create a customer yet.

**Immutable frontend commit:** `efb24cef0a432348c43b70600b74df367175ad22`.

**Image:** `ghcr.io/dansut24/hi5central-platform-admin:pilot-signup-preview-efb24cef0a432348c43b70600b74df367175ad22`
(digest `sha256:73ea69b87a1a1a4829707e7661e6356a2f404ad804cb1106d4e0ee40426843eb`).
This temporary, uniquely tagged image contains the **compiled ITSM marketing
frontend**, NOT Platform Admin. It was published through the existing
pullable image-package namespace solely because the newly created dedicated
preview package initially denied access to the VPS. No Admin `sha-*`
or production image tags were overwritten. This package alias should be
retired once the dedicated signup-preview package can be pulled normally.

**Container:** `hi5central-signup-ui-preview` on Docker-internal
`hi5central-signup-preview` network, shared only with the existing
`hi5central-web` gateway. There are no published host ports or
database/Redis access through this preview network. The separately
private `hi5central-pilot-signup-preview` container also remains on
the dedicated pilot network and is not publicly exposed.

## Public smoke test

The following requests were verified over public HTTPS, not assumed
from local container health:

| Endpoint | Result |
| --- | --- |
| `hi5central.com/signup?preview=1` | HTTP 200, new HTML references `index-phKYBGkb.js` |
| `hi5central.com/signup` | HTTP 200, original JS bundle `index-DbSEiplQ.js` |
| `hi5central.com/assets/index-phKYBGkb.js` | HTTP 200, correct new JS (1,990,492 bytes) |
| `hi5central.com/assets/index-DdDe0lV_.css` | HTTP 200, correct new CSS |
| `hi5central.com/healthz` | HTTP 200 |
| `admin.hi5central.com` | HTTP 200, original Prod Admin unchanged |
| `api.hi5central.com/live` | HTTP 200, original Prod API unchanged |
| `rmm.hi5central.com` | HTTP 200, original Prod RMM unchanged |

Read-only Production database check after deployment:
**4 tenants, 9 users, 124 migrations**, unchanged. Public ITSM,
RMM, Admin, API and gateway containers remained healthy.

## Critical live Caddyfile drift discovered and corrected

The old Docker container mounted an inode with content matching
`/workspace/deployment/Caddyfile`, although Docker's bind-mount
*source label* reported `/opt/hi5central/deployment/Caddyfile`.
Editing `/opt` did **not** change the mounted inode, and the first
attempt to reload therefore left public routes unchanged. No customers
were affected; the URL smoke test caught the discrepancy.

The successful configuration was edited in the **actively mounted**
`/workspace/deployment/Caddyfile`, verified visible at
`/etc/caddy/Caddyfile` within the running gateway, validated using
the gateway Caddy binary and hot-reloaded. The future Compose-recreation
path `/opt/hi5central/deployment/Caddyfile` was subsequently aligned
byte-for-byte to the active file. The result was confirmed via
`cmp -s` after deployment.

The pre-canary active configuration was preserved at
`/workspace/deployment/Caddyfile.before-phase24-signup-preview-20261010`.
An older `/opt` backup is at
`/opt/hi5central/deployment/Caddyfile.before-phase24-signup-preview-20261010`.
The **active `/workspace` backup** is the correct rollback source for
the currently running gateway and should also be copied to `/opt`
to avoid restoring a stale, older route map.

## Roll back the query-only public preview

Run on the authorised VPS only; this affects the gateway configuration
and should be done in a maintenance-aware window:

```sh
set -eu
before=/workspace/deployment/Caddyfile.before-phase24-signup-preview-20261010
test -s "$before"
cp "$before" /workspace/deployment/Caddyfile
cp "$before" /opt/hi5central/deployment/Caddyfile
docker exec hi5central-web caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec hi5central-web caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile
# After verifying original routes, optionally stop the isolated static preview:
docker rm -f hi5central-signup-ui-preview
docker network disconnect hi5central-signup-preview hi5central-web
docker network rm hi5central-signup-preview
```

This does not remove or alter any customer database or the distinct
private pilot control-plane containers.

## First pilot Admin recipient authorised (10 October 2026)

The user confirmed the first Admin recipient mailbox. The exact address
is stored **only** in a mode-0600, operator-private file on the VPS at
`/workspace/phase17-pilot-control/pilot-first-admin-recipient.json`,
alongside the existing dedicated pilot database scope UUID.

The staged request has status
`recipient_authorized_identity_and_signer_approvals_pending`; the
file itself **is not evidence that its mailbox has been verified**.

The first Admin issuer has been hardened to require
`PILOT_ADMIN_RECIPIENT_FILE` on `--issue`. The issuer validates
that the file is a regular owner-only file, that it has not already
been used to issue an invitation, and that its recipient and scope UUID
exactly match the signed operator/reviewer assertions. An independent
human operator and reviewer must still authorise it using separate
approved Ed25519 credentials and a separate pilot-scoped SMTP relay.

**No invitation email has been sent; no user or session was created.**
The isolated control database remains at zero users, zero tenants,
zero Admins, zero invitations, and zero control-plane identities. Existing
Production credentials or users are not copied to the pilot.

For an approved offline issuance, the first Admin command requires:
`PILOT_ADMIN_RECIPIENT_FILE=/workspace/phase17-pilot-control/pilot-first-admin-recipient.json`
alongside the existing `PILOT_OPERATOR_TRUST_FILE`, actor/reviewer
assertions, exact `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_EMAIL`,
`PILOT_CONTROL_DATABASE_URL` and a verified pilot SMTP relay.

## Blockers to full, real-browser signup and Admin acceptance

1. Enrol a named first **human** Platform Admin on the isolated pilot
   using verified email, independent signed operator approvals and MFA.
   Existing public Admin accounts are on a different Production database;
   swapping the entire public Admin hostname to an empty pilot database
   would make the existing customer records disappear from the view.
2. Configure a **separate reviewed SMTP relay** for public pilot signup
   verification and ensure the mail's verification URL uses an explicitly
   verified public route, not the currently denied `pilot-control-api`
   hostname.
3. Approve and test an **exact path-specific API gateway route** for the
   signup request and verification endpoints only, with the trusted
   reverse proxy overriding `X-Real-IP`. Do not redirect general
   `api.hi5central.com` traffic to the new pilot: Prod ITSM, RMM,
   agent check-ins and remote WebSocket sessions share it.
4. Make the pilot Admin review reachable to its authenticated owner
   without changing existing `admin.hi5central.com` users and their
   tenant view. Then switch to the reviewed public path when ready.
5. Provision separately attested, isolated Custom UAT and Production;
   then test the first-owner invitation/MFA and customer-specific
   configuration promotion with independent review and rollback.

**Do not call the visual canary a functioning public signup yet.**
The user may inspect the new form now. Form submission is intentionally
not a live customer-registration transaction.
