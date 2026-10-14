# QA26 test activation runbook

This PR stays **draft** until verified against only the two existing QA tenants:

- h5c-managed-qa26: ITSM Live + Test, no UAT; Live-only RMM.
- h5c-custom-qa26: ITSM Live + Test + UAT; Live-only RMM.

## Read-only operator preflight

On an authorised operations host with approved DATABASE_URL, TENANT_TEST_DATABASE_URL, TENANT_UAT_DATABASE_URL, the current ENV_IDENTITY_SHARED_SECRET (or its _FILE), and sandbox ENV_IDENTITY_API_URL:

    cd services/api
    node scripts/qa26-readiness.mjs

The script does SELECT queries under PostgreSQL READ ONLY transactions. It checks only these two exact slugs, required schema, update policies, Live tenant status, sandbox identity/RMM isolation and identity-service configuration. It prints PASS/BLOCKED without database URLs, passwords or customer records. It does not migrate, deploy, create tenants, alter data, start remote sessions or change gateway routes. A BLOCKED result must stop QA activation.

## QA browser acceptance after explicit QA-only rollout

1. Managed Live sign-in + MFA; only Test offered. Test accepts existing central login and cannot edit shared People.
2. Custom Live sign-in + MFA; Test and UAT offered; UAT shows a clear banner. Verify same People names across Live/Test/UAT and no sandbox edits.
3. Custom UAT: change a non-sensitive ITSM setting, inspect change-history actor/time/key/hash; repeat same value (no duplicate); confirm Live unchanged. Test has no promotion-tracking ledger.
4. RMM: confirm Test/UAT do not expose agent jobs, remote, patch or broker functionality. Never run an operational endpoint action in sandboxes.
5. Live ITSM: link a disposable QA ticket to a QA RMM device and, with consent on a test endpoint, check one-click browser remote view. Verify remote permission denial for a user lacking rmm.devices.remote.
6. Validate mobile login scroll/MFA, environment banners, browser session refresh and rollback capability.
7. Verify unaffected tenants and Live RMM device counts unchanged.

Migration on the isolated databases and compatible Live People internal route must precede switching sandbox app/API code. Preserve original image digests, DB backups, and exact gateway mappings for rollback. Do **not** merge PR #69 into main or publish shared Production image tags merely to enable QA.

## Continuation summary

As of 14 October 2026 PR #69 provides Managed/Custom sandbox boundaries, Live-owned People API read-through, ITSM settings-only audit history, Live-only RMM and direct ticket remote launch. Isolated GitHub/Postgres tests are green; run the read-only readiness tool then perform authorised QA26 browser tests. Halo-style Ahead/Behind and selective sync still require a separate phase.
