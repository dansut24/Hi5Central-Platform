# Phase 28 — first real single-owner Admin invitation test

Date: 10 October 2026. **Private preflight completed; real invitation not issued.**

## Completed on VPS

- Latest fully green CI revision:
  `40444479584e9674b80b4849af1d319c6bc8e588`:
  https://github.com/dansut24/Hi5Central-Platform/actions/runs/38044168493
- Matching immutable private pilot API/Admin images installed (API
  `sha256:794bb6d09b409751e93c76670bf9f9e6b2138bf8ea9734e21bf92861e6b7422d`,
  Admin
  `sha256:3f2c3290e23cbbb4e206fa46a147164f4df07b826cb9b9256af3fe0da359ad7b`).
- Both containers healthy; schema migrations exited 0.
- First-owner CLI `dist/pilot-admin-bootstrap.mjs` exists in the
  immutable API image (earlier build omitted it).
- One-shot, **read-only** first-owner CLI `--check` passed from a
  disposable Compose container against only `hi5pilotcontrol`:
  zero users, zero Admin members, zero tenants, no open invitation,
  and no previously attested control-plane identity. `--check`
  does NOT approve or send an invitation.
- Operator-private mode-0600 recipient file matches approved test
  mailbox and the pilot DB UUID. Single-owner initial-admin policy is
  explicitly enabled; MFA remains mandatory.
- The existing Production SMTP account is already configured in
  the **private pilot API**, authenticated successfully, and the
  approved Outlook recipient confirmed delivery of a no-action
  test email.
- The public Production database stayed at **4 tenants / 9 users**.

## Public ingress blocker

Pilot Admin / API hostnames still returned HTTP 404 on the existing
gateway before this operation. Gateway-to-pilot internal connectivity
was smoke tested (Admin healthz returned `ok`), but writing the
required public gateway route was blocked by the connection's
deployment safety controls; **no host route was published**.
The temporary gateway-to-pilot Docker network attachment was
disconnected afterward. Do **not** send the 24-hour invitation email
until the actual HTTPS URL is routable and tested.

A reviewed change must route:
- `https://pilot-admin.hi5central.com/*` to the isolated private
  pilot Admin static frontend, with HTTPS, HSTS, no-referrer and
  no-store policies;
- `https://pilot-control-api.hi5central.com/api/platform/v1/auth/*`
  to the isolated pilot API. Keep full public access to other private
  pilot API namespaces blocked;
- after Admin login/MFA, only the authenticated signup review path
  `GET /api/platform/v1/signup-requests` and required supporting
  read-only Platform Admin resources, separately reviewed.

Before the mail:
1. Validate that `GET /accept-admin-invitation` on the pilot Admin
   HTTPS host returns the correct HTML/JS and points to its isolated
   pilot API.
2. Confirm API authentication preflight permits only the trusted
   pilot Admin Origin, rejects untrusted origins, and serves no
   privileged unauthenticated response.
3. Confirm the existing `https://admin.hi5central.com` and
   `https://api.hi5central.com` still target Production, with
   tenant/user counts unchanged.
4. Run the offline issuer `--issue` **once** with its exact
   protected recipient, private DB scope, and single-owner approval
   confirmation. The command must never print the token.
5. Recipient redeems link, chooses password, signs in, enrols MFA
   and stores the one-time recovery codes.
6. Only after a real Admin login is verified, activate the
   approved-address-only `hi5central.com/signup?preview=1` test:
   POST signup request, send same-site one-time email link,
   verify it, see verified request in Admin review queue.
7. Keep tenant provisioning and UAT/Production activation in
   their separate gated workflow. No update-mode choice at signup;
   first owner chooses Managed or Custom/UAT during onboarding.

### Status invariant

**No real Admin invitation, user account, customer signup or
environment activation was created during this phase.**
