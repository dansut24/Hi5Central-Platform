# Production onboarding restoration and Hi5Central web-update ownership

## Confirmed Production observations (10 October 2026)

The new tenant `testenv` is **active**, with ITSM + RMM enabled, currently at `onboarding_step=security`. Its existing `onboarding_data` contains **company, theme, users, groups and permissions**. No tenant data was reset or changed during diagnosis.

Production was running the October 2 `hi5central-itsm:production-working-peek-v74` frontend, which uses the older wizard and restores from `/api/v1/auth/session`; current Production API lacked `GET /api/v1/onboarding/session`, `POST /api/v1/onboarding/save` and the tenant release preferences migration. This is a **mixed-version deployment**, not a failure of the first five saved steps. Production API health and signup were healthy. Do not diagnose this as a lost tenant.

## Coordinated implementation

Use the current main-platform `OnboardingWizard`: Next, Previous, saved step edits, domain/email delivery, security, ITSM and RMM. Insert `updates` between Security and ITSM/RMM. The choice is:
- **Hi5Central managed** (`hi5_managed`) — Test synchronisation, UAT auto-stage, Live auto-promotion after an adjustable 0–720 hour delay; emergency Hi5Central security updates separately controlled.
- **Custom / admin controlled** (`admin_controlled`) — Test synchronisation while tenant administrators choose UAT staging and Live promotion.

These settings apply to Hi5Central application releases, **not agent software patching, Microsoft/Windows updates or general device management**. They are saved to tenant_release_preferences and tenant_environment_state transactionally with onboarding progress. Initial wizard default is Hi5Central-managed for hosted, admin-controlled for self-hosted; either can be chosen where permitted. The choice is shown in Review and can later be changed via Release Management.

All onboarding step/edit/complete routes resolve the dedicated verified owner/admin **onboarding session** rather than requiring fully provisioned workspace RBAC. The newer frontend likewise refreshes its dedicated onboarding session, offers a retry/sign-in escape, and never overwrites stored progress with a local cache if the server has progressed. A single user can belong to multiple organisations; when completing an additional tenant, existing global user experience preferences are preserved (no forced first-login reset).

No longer trust a cached onboarding snapshot after server returns unauthorized or an inconsistent tenant ID. Do not reuse a session created for a different tenant.

## Verification

PR CI uses PostgreSQL 17 + Redis 8 + Node 24 and starts the real API. It seeds a disposable active tenant with five saved steps then verifies:
- `GET /api/v1/onboarding/session` restores the Security step and previous data.
- Only the current step can advance; Security -> Updates -> ITSM is enforced.
- Invalid update modes reject without advancing.
- Saving a previous step does not erase later progress.
- Managed vs customer-controlled preference persists, including UAT/Live flags and delay.
- No other tenant release settings are modified.
- The existing multi-tenant signup regression and all four platform container builds remain green.

## Safe promotion order (not performed by this PR)

1. Verify a protected backup of Production PostgreSQL, configuration, and current API + ITSM images. Confirm historical tenant runtime versions, routing, and rollback.
2. In Dev, deploy a **matching** current-platform API (with migrations) and ITSM frontend and run the full Security->Updates->ITSM->RMM->Review->workspace path.
3. Test recovery after refresh, stale/cross-tenant cookie, previous-step edits, and sign in again.
4. Before Production, resolve schema migration dependencies: the existing Production database does not yet contain tenant_release_preferences. Never deploy the new wizard against the old Production API. Avoid applying migrations without review and verified rollback.
5. After tested cutover, revisit `https://testenv.hi5central.com/onboarding`; it must resume from its persisted Security step, not restart onboarding. Do **not** delete or manually mark the tenant complete.
6. Verify both ITSM and RMM reach the selected tenant after finishing, and release preferences in Release Management reflect the chosen option.
7. Use a coordinated deployment/rollback, and ensure the Production Caddyfile pinned bind-mount issue is reconciled before any gateway recreation. Do not inadvertently revert the production signup route.

### Explicitly outstanding
This PR alone **does not** update Production containers, Production schemas, or prove a real user finished onboarding. A successful CI result is necessary but not sufficient. The current live customer may still need to sign in again to restore the correct tenant-scoped cookie.
