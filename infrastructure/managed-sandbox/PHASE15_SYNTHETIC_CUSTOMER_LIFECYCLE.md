# Phase 15 — Synthetic customer lifecycle testing

**Status: Phase 15 synthetic owner and requester Portal lifecycle PASSED in
both disposable UAT and Test environments on immutable published API/ITSM
revision `10bf85b57e65b29efcebee8e5197f500ec4bebb7`. Verified in GitHub
Actions and repeated on the authorised VPS on 10 October 2026. This does NOT
constitute approval to activate a real customer pilot.**

## What was executed

On 10 October 2026, the `synthetic-runtime-smoke.mjs` harness was extended
with `HI5_PHASE15_SMOKE=1` and
`synthetic-customer-lifecycle.mjs`.

It used the matching, previously published Phase 14 API/ITSM images, separate
temporary UAT and Test PostgreSQL/Redis instances, and individual Docker
internal bridges. Every database was freshly migrated and cryptographic key,
invitation token, session, and customer ID was test-generated. No Production,
legacy customer, or engineering Dev records were read or copied.

The **first completed execution** passed in **both** environments:

- Synthetic tenant and first-owner token initially suspended; accepting
  the token was denied (HTTP 423).
- An approval in a *still-suspended* tenant did not grant access.
- With a synthetic approval and manually switched active state in scratch
  **only**, a wrong customer Origin was rejected.
- Initial owner one-time invitation accepted without a session. Replaying
  the invitation token returned HTTP 401.
- Password sign-in gave an MFA challenge but no session. Incorrect TOTP was
  rejected; the right TOTP enrolled MFA and issued a secure, HttpOnly,
  **host-only** session cookie.
- The authenticated session worked for the correct customer Origin but
  failed for another customer Origin, missing Origin, and the other
  environment's separate API.
- Revoking the synthetic approval immediately invalidated existing sessions
  and blocked new sign-ins. Tenant suspension separately denied both sessions
  and login.

Result: `PHASE15_SYNTHETIC_CUSTOMER_LIFECYCLE: PASS` followed by
`PHASE14_SYNTHETIC_RUNTIME_SMOKE: PASS`, **exit 0**, and confirmation
that all temporary containers and networks were removed.

### Actual invitation email and requester Portal test

A second run added an isolated, in-container SMTP sink to each ephemeral
bridge. No public SMTP, real address, host port or outbound email was used.

The real API successfully sent a new **requester** invitation into the
temporary mailbox (HTTP 201). The test read the delivered one-time link
without logging its raw token; the requester redeemed it and proceeded
through password login and TOTP enrolment.

That second test correctly **failed** at TOTP verification with HTTP 403,
because the published API tried to create a **staff workspace session** for
a requester who should only have customer Portal access.

Source fixes on `develop`:
- `services/api/src/secureLoginSurface.js` computes Portal vs staff surface
  from the request's validated origin information.
- `services/api/src/mfa.js` passes the correct session surface to
  `createSession()` in both password-only and MFA-verified branches, and
  produces the corresponding surface-aware login payload.
- `services/api/src/managedSandboxInvitations.js` and
  `managedSandboxInvitationRoutes.js` direct `requester` links to the
  customer Portal, not the staff workspace.
- The synthetic test now runs the requester login, MFA and permission
  assertions **from the Portal origin**, verifies staff workspace isolation
  and rejects invitation issuance by requester role.
- New pure regression tests cover origin-based session selection and
  invitation destinations. **Five passed locally.**

**Retest result (10 October 2026): PASSED.** The original published image
was missing a Portal session cookie after successful requester MFA. The fix now
issues a surface-appropriate, secure host-only Portal cookie for Portal-origin
login and TOTP verification. New unit coverage checks correct Portal and staff
cookie separation.

The dedicated [Phase 15 CI run](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38008097115)
built matching API/ITSM images, passed the complete real-image owner and
requester synthetic lifecycle, verified scratch cleanup and published immutable
images tagged `sha-10bf85b57e65b29efcebee8e5197f500ec4bebb7`.

The same two immutable image tags were pulled onto the authorised VPS and
exercised against independently created internal UAT and Test PostgreSQL, Redis,
API, frontend and SMTP containers, without using compatibility overrides or
published ports. Both environments passed actual one-time invitation delivery,
MFA challenge and TOTP setup, requester Portal sessions, no staff access or
invite permission, cross-environment cookie denial, approval revocation and
tenant suspension. Both harnesses printed
`PHASE15_SYNTHETIC_CUSTOMER_LIFECYCLE: PASS` and
`PHASE14_SYNTHETIC_RUNTIME_SMOKE: PASS`, exiting 0.

Post-run verification found no `hi5-p14-*` or `hi5-p15-*` containers or
networks. The live Dev API remained on `3307da9`; Production and legacy UAT/Test
containers stayed healthy. Four representative unapproved customer/API
hostnames continued returning HTTP 404. Test email delivery was to isolated
disposable SMTP only, not an external customer inbox.

## Repeat commands (authorised test host only)

```sh
# Requires the matching published API/ITSM :dev images already pulled,
# PostgreSQL 17, Redis 8 and local Docker capability. Destructive only to
# the uniquely named hi5-p14 scratch resources it creates.
HI5_PHASE14_SMOKE=1 HI5_PHASE15_SMOKE=1 node \
  infrastructure/managed-sandbox/synthetic-runtime-smoke.mjs \
  --run --confirm EPHEMERAL_SYNTHETIC_ONLY
```

The harness never connects scratch containers to the prepared long-lived
`hi5central-sandbox-uat-edge` or
`hi5central-sandbox-test-edge` bridges; it creates and removes its own
`hi5-p14-scratch-*` networks. PostgreSQL, Redis, API, ITSM and local SMTP
containers have no published ports. All actual customer routes remain HTTP
404 at the public ingress.

The test is configured to fail closed on errors and has a `finally` cleanup.
After an abnormal process interruption, independently check that no
`hi5-p14-*` containers or scratch networks remain.

## Not yet validated for live pilots

The successful synthetic run used direct test-only SQL to construct suspended,
approved and active **fixture states**. It does **not** constitute real
operator attestation or a successful human-approved control-plane cutover.
Separate Phase 9 operator tests exist, but they are not a substitute for
independent authenticated operators and audit evidence.

Outstanding: run the corrected requester MFA flow with new immutable images;
test the first-owner operator mail issuance and cancellation; test granular
permission matrix for admin/analyst/requester, approval assignments and
invitation rate limits; browser-based navigation, first login and logout;
time-boxed pilot isolation and rollback; operator approval, backed-up private
runtime and scoped mail egress. Production and legacy UAT/Test were untouched.
