# Phase 18 — mandatory private Platform Admin MFA

**Verified on 10 October 2026: PASS against the isolated managed pilot API.**
**Not authorised for public access, tenant onboarding or live production changes.**

## Shipped to the private VPS pilot only

- `PLATFORM_ADMIN_MFA_REQUIRED=true` on
  `hi5central-pilot-control-api-1`. The flag is enforced by
  `infrastructure/managed-pilot-control/validate.mjs`. Existing Dev,
  Production and legacy UAT/Test containers remain unchanged.
- New migration `141_platform_admin_mfa.sql`: separate Admin MFA methods,
  password-stage challenges and a nullable proof-of-MFA session timestamp.
  The pilot migration job completed successfully.
- `services/api/src/platformAdminMfa.js` implements AES-256-GCM encrypted
  TOTP seeds, 10-minute one-use challenge tokens stored as SHA-256 hashes,
  invalid-attempt limits, 30-second TOTP time steps and replay prevention.
  Recovery codes are generated after first verified MFA enrolment and stored
  only as salted-by-entropy cryptographic hashes; each can be used once.
- The Platform Admin password endpoint **does not create a session** when
  pilot MFA is enabled. A second `/api/platform/v1/auth/mfa/verify` step is
  required to issue the only privileged session, whose DB record has
  `mfa_verified_at`. A password-only or legacy pre-MFA session is denied
  by the normal session middleware.
- Tenant workspace SSO is disabled as a shortcut into Platform Admin on the
  pilot MFA path. The pilot Admin login UI supports TOTP enrolment, existing
  authenticator verification, and display of first-enrolment recovery codes
  exactly once before opening Admin.
- All MFA materials are scoped to this private pilot control database; no
  Dev/Production credentials, users, sessions or MFA secrets were copied.

## Verification

- [Admin MFA unit tests, static control-plane preflight and matching API/Admin
  image build](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38031190037):
  green, including code replay denial, encryption integrity, recovery-code
  generation and SSO bypass guards.
- Matching API/Admin image revision installed on the VPS:
  `d5fa322d399853a23c0fc2bddd3e7c3cd20b0c7c`.
  API digest `sha256:7f2afc03a7533477c8a927de1a911b4ba0a9a75486c603c0ca3eac2cf422a04c`;
  Admin digest `sha256:71e85c6f9df3a0eedde12d8154a2b9d05b238e2ee82c2552f26a9a6b422acbf5`.
- Ran the explicitly gated
  `private-admin-mfa-smoke.mjs --run --confirm PRIVATE_PILOT_SYNTHETIC_ADMIN_ONLY`
  against the **real running private pilot API** (not a mocked endpoint).
  It created a single random synthetic Platform Admin with an
  `example.invalid` email address and tested:
  - unauthenticated Admin 401 and incorrect-password 401;
  - incorrect Origin 403 and password login with no session cookie;
  - authenticator enrolment and invalid TOTP rejection;
  - correct TOTP, secure/HttpOnly host-only session, authenticated Admin
    session and tenants endpoint;
  - consumed MFA challenge replay 401, logout and session revocation 401;
  - same-step TOTP replay rejection and valid single-use recovery login;
  - used recovery-code replay rejection.
- Script output: `PRIVATE_ADMIN_MFA_SYNTHETIC_SMOKE: PASS`.
  A `finally` cleanup removed the temporary user and its dependent methods,
  challenges and sessions. Follow-up independent VPS read verified
  **0 users, 0 platform admins, 0 customer tenants and 0 admin sessions**.
- Both private API and Admin containers are healthy, and the authoritative
  gateway still returns HTTP **404** for both unpublished pilot hostnames.
  No host ports have been published. Dev/Production/legacy stacks remain healthy.

## Remaining gates before owner can create an actual customer

1. Separately verify the first real Platform Admin owner's email/identity
   and approved initial password or one-time invitation channel. No email
   address was chosen or created automatically.
2. Add reviewed, independently authorised first-owner bootstrap with
   explicit audit, one-time invitation expiry and cancellation. New Admin MFA
   will enforce enrolment on first login; do not grant a password-only
   session during bootstrap.
3. Verify the first **real browser** login, Authenticator QR/manual setup,
   recovery-code acknowledgement, logout and re-login on the exact scoped
   pilot Admin URL; avoid public routing until domain/TLS/SMTP approvals.
4. Obtain human operator/reviewer identity custody and signed gateway
   activation approvals, off-host encrypted backup with restore evidence
   and outbound SMTP scoping. An on-VPS database restore alone does not
   satisfy off-host disaster recovery.
5. Only then publish individually approved pilot Admin/API domains; owner
   creates customer slug and requests isolated UAT/Test provision. Test/UAT
   host routes and first-customer invitations must be separately approved.
6. Customer Production, software/Agent/Viewer rollout, cross-environment
   configuration promotion and Test reset are **not** covered by this phase.

The pilot remains private and empty, ready for a verified first-admin
onboarding ceremony; the demo/synthetic account has been deleted.
