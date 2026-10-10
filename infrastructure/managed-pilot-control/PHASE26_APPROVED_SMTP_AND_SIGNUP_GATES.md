# Phase 26 — Outlook mail receipt and controlled signup preflight

Date: 10 October 2026

The pilot's designated first-Admin invitation recipient explicitly confirmed
receipt of the no-action SMTP delivery test sent to the approved Outlook
mailbox. This establishes **relay acceptance and human-observed delivery**,
not acceptance of a first Admin invitation, mailbox ownership proof by
a one-time link, or MFA enrolment.

## Verified private pilot changes

- Reused the **existing Production SMTP account settings**, solely within
  `/workspace/phase17-pilot-control/smtp.env` (mode 0600) on the VPS.
  Neither the SMTP secret nor the recipient verification token is committed
  to GitHub or printed in logs.
- Added `smtp.compose.yml`: **only** the private pilot API connects to
  `hi5central-pilot-mail-egress`; the pilot Postgres, Redis and Admin do not.
  No new public API ports were published. Production SMTP settings remain
  unchanged.
- `nodemailer.verify()` from the isolated pilot API: **PASS**.
- A single no-action email to the approved recipient was accepted by the
  provider, with zero rejected recipients; receipt was confirmed directly.
- Backed up the pilot DB, then migrated/recreated matched immutable API/Admin
  images from successful CI revision
  `65e4ab1bb488eb9af8f0c5e1a263a3b2f1242089`.
  Postgres migration completed 0, both services healthy, and the pilot
  control database retained zero Admins, zero users, zero tenants, zero
  invitations and zero public signup requests.
- Enabled `MANAGED_SIGNUP_TEST_ONLY=true`, with the approved private
  test address in the operator-only `runtime.env`. Kept
  `MANAGED_SIGNUP_SMTP_APPROVED=false` until exact public submission and
  verification routing is approved.
- Private HTTP smoke test: unapproved address **403**, bad origin **403**,
  approved address with disabled signup mail **503**, and premature UAT
  selection **400**. No rows created.
- The latest compiled marketing preview from this same revision was
  published only to the existing query-limited public visual canary
  `https://hi5central.com/signup?preview=1`. New hashed bundle
  `index-CBaIO6bd.js` returns HTTP 200 and references the signup request
  endpoint. Original `/signup` and its assets remain unchanged.
  Current Caddy active and restart configurations are in sync. A rollback
  backup exists at each path with suffix
  `.before-phase26-mail-preview-20261010`.
- Public smoke check: preview page **200**, original signup **200**,
  preview JS **200**, marketing health **200**. Original Admin, API, RMM
  endpoints continued to return HTTP 200.
- Production DB stayed **four tenants, nine users and 124 migrations**.

## Remaining mandatory gates before a real user submission

**No public signup request should be sent yet.** A preflight attempt to
deploy the dedicated two-endpoint public signup relay was blocked by
deployment safety checks, so that relay has **not** been deployed.
The verification link has no authorised public path at present. Do not
flip `MANAGED_SIGNUP_SMTP_APPROVED` to true without first confirming
TLS, approved exact-method/route proxying for only
`POST /api/v1/public/signup-requests` and
`GET /api/v1/public/signup-requests/verify`, strict allowlisting,
a real browser test, and appropriate rate-limit provenance.
Never expose the entire pilot API or alter the shared Production API
hostname to accomplish this.

**The first Admin invitation is also not issued yet**: it requires the
verified recipient, the separately authorised signing identities,
Ed25519 operator/reviewer assertions, protected trust file, an audited
mail ceremony and owner MFA, followed by evidence that the invited
administrator can read the reviewed signup queue. The received
no-action test message cannot substitute for these approvals.

Once those gates pass, submit a single pilot request from the approved
address through the visual preview, click the one-time email link, and
confirm a verified pending signup in Admin. Then perform the separate
customer UAT provisioning and owner onboarding workflow. Signup only
collects company, desired URL, owner contact and products;
Managed/Custom/UAT decisions are deferred to authenticated onboarding.
