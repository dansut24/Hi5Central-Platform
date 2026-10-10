# Phase 27 — Single-owner first Platform Admin

## Why this exists

Small businesses and single-person trials do not have a second human
administrator to approve their own signup. **First Platform Admin
bootstrap must not require a second human.** Preserve optional,
separately signed `dual_control` for larger businesses.

## Security model

The private managed pilot has an **opt-in `single_owner` mode**:
`PILOT_ADMIN_APPROVAL_MODE=single_owner` plus
`PILOT_BOOTSTRAP_SINGLE_OWNER_APPROVED=true`.

The following protections are **still mandatory**:
- The new mode is restricted to the exact empty pilot control
  plane, its database identity and the approved, owner-only recipient file.
- The intended first recipient has been approved and a no-action
  SMTP delivery test was accepted and confirmed received.
- The command must be invoked locally by an authorised VPS operator
  using the exact `<scope_uuid>:<email>:invite` confirmation.
- A 256-bit random, one-use, 24-hour invitation link is sent via SMTP.
  **Only a recipient with mailbox access can redeem it.**
- Redemption requires a strong password, permits no session, is
  audited and is valid for exactly one initial user.
- The owner signs in and configures TOTP-based MFA before the first
  privileged Admin session can exist.
- The DB explicitly tracks `approval_mode='single_owner'` and stores
  no fake reviewer. A separate `dual_control` mode remains available
  for enterprises. Single-owner mode must never accept a dual-control
  recipient file, and vice versa.
- No customer UAT, Production environment, RMM or ITSM tenant can be
  created implicitly by this bootstrap operation.

## Verified 10 October 2026

The following was implemented, tested and deployed **privately only**:

- PostgreSQL migration
  `147_single_owner_pilot_admin_bootstrap.sql`;
- `pilotSingleOwnerBootstrapEnabled` and scoped issuer;
- explicit owner-only recipient policy status;
- API invitation redemption validates the stored approval mode and
  grants no session;
- security unit tests, a disposable PostgreSQL/API integration test
  covering one-use redemption, password, TOTP MFA and session handling;
- matched immutable API/Admin revision
  `b5535bd3c6ee4358c87af004641d3fb3c884db80`
  deployed to `hi5central-pilot-control`, migration exit 0, both
  containers healthy; the control DB still has **zero** Admin users,
  invitations, tenants or customer signups.

[Successful Phase 27 tests](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38043739518).

A second follow-up build now packages the previously missing offline
bootstrap issuer at `dist/pilot-admin-bootstrap.mjs`, so it can be
executed from a disposable one-shot operator container using the exact
private pilot environment, without mounting secrets into the long-lived
API service. That image has a separate CI check.

The authorised recipient is staged at
`/workspace/phase17-pilot-control/pilot-first-admin-recipient.json`
(mode 0600) with the verified private pilot scope UUID and status
`recipient_authorized_single_owner_email_verification_pending`.
The operator also explicitly enabled the single-owner runtime policy
in mode-0600 `runtime.env`, and backed up the previous runtime config,
recipient file and PostgreSQL database before migration. Existing
public Production Admin/API and customer records have not changed.

## Next human/browser steps (do not send an unusable invitation)

1. Ensure the reviewed *separate* pilot Admin origin
   `https://pilot-admin.hi5central.com/accept-admin-invitation`
   and the exact limited API auth routes are reachable over trusted
   HTTPS with correct cookie/origin behaviour. At present public
   pilot hostnames are not yet approved for ingress; **do not issue a
   time-limited email link until it can be opened successfully.**
2. In a one-shot operator container, validate the approved recipient,
   matching scope and bootstrap CLI `--check`; use the exact
   owner-confirmation phrase and `--issue` only after the public
   invitation route is verified. The CLI must never print the token.
3. The owner clicks the email link, chooses a password, logs in,
   configures TOTP, and receives a host-only, Secure, HttpOnly
   session *only after MFA*. Reuse or expiry of the link must fail.
4. After a successful signed-in Admin pilot test, perform one
   email-verified signup on the approved Outlook test address
   (`hi5central.com/signup?preview=1`) and confirm it appears
   in the independent Admin review queue.
5. Only then perform customer environment provisioning,
   first-owner onboarding and the explicit Managed/Custom UAT choice.

**No second approver needs to be nominated to complete steps 2–4.**
For later actual customer-production environment activation,
independent infrastructure approvals and backup/rollback gates
remain separate from first-user signup policy.
