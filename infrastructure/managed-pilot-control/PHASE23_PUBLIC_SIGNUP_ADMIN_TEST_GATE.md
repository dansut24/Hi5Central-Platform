# Phase 23 — testable signup → Admin customer registration (Managed/Custom)

**Do not advertise public signup as active until both public hostnames and an
approved, restricted SMTP relay are working.** This phase deliberately does not
change `hi5central.com`, `admin.hi5central.com`, Production DNS or the shared
Production API.

## Implemented in develop

- `hi5central.com/signup` now has an alternative **Managed-hosted** request
  flow. It collects company name, requested URL, owner name/email, products,
  and an explicit **Managed** or **Custom** update policy.
- Managed means the customer selects a deployment window, with dedicated UAT
  optional. Custom requires dedicated UAT and manual UAT → Production
  approvals.
- Public managed signup **does not request or store a customer password**,
  create a tenant, grant a membership, mint a cookie, activate a hostname
  or claim Production/UAT is provisioned. Submission sends a one-time
  verification link through a separately approved SMTP relay.
- The public request is stored in
  `managed_public_signup_requests` (migration `145`), with a SHA-256
  email-token hash, 24-hour expiry, restrictive status transitions and an
  append-only `managed_public_signup_audit`.
- A separately authenticated Platform Admin may list requests and choose
  **Review and register**. The prefilled tenant creation call is bound to
  the exact verified company, owner, slug, modules, update mode and
  UAT preference, and the signup request becomes `converted` atomically.
  A second conversion is rejected.
- Tenant registration then records pending environment state, first-owner
  onboarding contact and a separately operator-approved Custom UAT
  provisioning queue. **It does not install a customer environment yet.**

## Deliberate ingress and abuse-prevention gates

The new endpoints accept requests only when `MANAGED_SIGNUP_REQUESTS_ENABLED`
is explicitly true on the **dedicated isolated live managed pilot API**,
with exact `API_URL=https://pilot-control-api.hi5central.com`,
`ADMIN_URL=https://pilot-admin.hi5central.com` and managed multi tenancy.
Public request submission also requires:

- Exact browser `Origin: https://hi5central.com`;
- valid nonreserved customer slug and owner email;
- separate Redis rate limits per requester and email address;
- a hidden honeypot field, a size cap and strict Managed/Custom schedule validation;
- `MANAGED_SIGNUP_SMTP_APPROVED=true` and a separately approved, tested
  SMTP service. Without that, the service must return HTTP 503 **without
  reserving a customer URL**. Failed deliveries revoke the request;
- manual Platform Admin review of the confirmed email. Verification alone
  never activates a tenant.

The old `POST /api/v1/auth/signup` direct-activation path is **disabled by
default** for the new managed multi-tenant API unless a special
`MANAGED_LEGACY_SIGNUP_ALLOWED` override is explicitly provided. It must
remain unset in the pilot and subsequent public release. Self-hosted
initialisation remains separate.

## Public testing sequence after independent approval

1. Complete independent Platform Admin first-owner verification and MFA,
   restricted SMTP configuration, and secure TLS/ingress for the pilot
   management API/UI. Current persistent pilot has **no real Admin user**.
2. Use a non-public canary matching the **exact API/Admin/marketing image
   revisions**, with a synthetic owner and mail sink to prove submission,
   one-time email confirmation, replay expiry and independent Admin review.
3. Approve narrowly scoped public host routing: marketing
   `https://hi5central.com/signup` and reviewed API signup endpoints, without
   switching all of `api.hi5central.com` or unrelated ITSM/RMM WebSockets.
4. As a verified Platform Admin, inspect the queued verified request at
   `https://admin.hi5central.com`, review and register one **Custom** pilot
   customer. The first owner remains uninvited until independently verified
   UAT/Production provisioning and approval.
5. Test dedicated UAT activation with separate DB/Redis, first-owner
   invitation/MFA, selected onboarding settings and a typed, allowlisted
   configuration change. The customer-specific UAT → Production executor
   still requires its own diff, authorisation, transactional apply/rollback,
   and live-isolation tests.

**A queued signup is not proof of a functioning customer.** The public
hostname cutover is also still gated by the shared API regression and
off-host Production backup/rollback checks documented in
`PHASE22_PRODUCTION_CUTOVER_GATE.md`.
