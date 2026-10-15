# Selective Custom ITSM configuration promotion: UAT → Live

**Status:** PR #69 implementation, release/rollout pending. This is a customer-specific settings change, not a shared API/ITSM image release. Do not merge, install the Live database migration or upgrade the Live API/frontend without an approved production release window. No tenant configuration has been promoted by this PR.

## Customer experience

Custom ITSM owner/administrator opens their **Production** workspace → Settings → Platform → Releases → **Promote individual ITSM settings from UAT**. Live reads the protected UAT database and displays a per-field list with Live values, latest UAT values and their audit date. Every row has a separate **Promote this setting** confirmation; no full-settings copy or implicit group promotion. Selecting "Projects → Show milestones" only changes `projects.showMilestones`.

Review statuses:

- **Ready:** latest UAT event contains a safe approved field; the UAT current value still matches that event; Live currently equals the reviewed UAT starting value (including explicitly documented built-in defaults).
- **Already matches Production:** someone independently made the same change in Production, so it is not re-applied.
- **Conflict:** Production changed differently; administrator must review instead of overwriting.
- **Unknown baseline:** previous values/default cannot be proven; no automatic promotion.
- **Superseded:** UAT changed since the event, so older selections are ineligible.
- **Promoted/Reverted:** tracked by an append-only approval record; already reviewed events cannot be replayed.

A confirmed promotion loads the latest trusted UAT change under the locked Live settings transaction, applies one allowlisted scalar field to the existing Live ITSM JSON (preserving other settings), records the value change in Live history, and records actor, exact UAT event and time in `itsm_configuration_promotions`. Rollback restores only the previous known value if no later Live edit touched the same field. An independent post-promotion audit entry remains available.

## Security model

- Live session, same tenant origin, active Custom ITSM policy, owner/admin role and `settings.itsm.manage` are required.
- The UI sends **only** an existing UAT event UUID and its field path; it cannot supply target values or select an arbitrary tenant ID.
- The Live API already has a protected `TENANT_UAT_DATABASE_URL_FILE` connection (confirmed configured on QA VPS). It opens a short-lived **read-only** UAT connection and requires exactly the matching tenant UUID and canonical `-uat` slug. No new public gateway route or UAT write service is required.
- Promotion reads only UAT `delta-v2` audit rows and the current ITSM settings for comparison; it does not replicate the complete UAT database.
- Field values must be on the explicit `itsmAuditValueDisplay.js` safe allowlist. It excludes passwords, emails, webhooks, arbitrary text, People, company/legal name, branding, billing, all RMM devices/policies, and operational ITSM tickets or projects.
- Unknown baseline, stale entries, duplicate approvals, source drift and conflicting Live values fail closed. Approvals are serialized by `SELECT ... FOR UPDATE` and uniquely identified by tenant UUID, UAT event and field path.
- Rollback additionally checks whether the relevant Live field has appeared in a later audit event. If so, it blocks to avoid overwriting a newer administrator edit.
- A restored setting can be explicitly selected in a future, newly recorded UAT change; old event IDs cannot be reused.

## Database and release

**Full PR #69 Live migration order:** first `services/api/migrations/platform-admin/155_app_release_executor_heartbeat.sql` (dedicated deployment-executor readiness), then `services/api/migrations/itsm/156_itsm_configuration_audit_value_summaries.sql` (safe `value_changes` column), then `services/api/migrations/itsm/157_itsm_configuration_promotions.sql` (per-field approval history). Selective setting promotion itself uses 156 and 157; the wider shared application release also requires 155 because its Admin/release endpoints query that new table. Read-only VPS inspection confirmed migration 154 exists while 155/156/157 are all absent from Live. On 15 October 2026, all three scripts passed in order against an **isolated Live-schema-only database with zero customer rows**, subsequently deleted. UAT already has 156. A protected 40 MB Live `pg_dump -Fc` backup at `/opt/hi5central/deployment/pilots/qa26-pr69-20261015/backups/` passed `pg_restore --list` and operator-reported SHA-256 checksum verification; a complete data-restore/off-host recovery drill remains outstanding. Apply 155→156→157 to Live **only after an approved shared Production maintenance/release gate**, current backup/rollback preflight and normal migration bookkeeping, before deploying the new official API/ITSM images. None of these migrations has yet been executed against Production. Neither migration copies People, records or RMM data.

The new Live route is `/api/v1/release-management/configuration-promotions`:
- `GET`: customer-scoped read-only preview and approval history.
- `POST`: explicit one-field approval from an immutable UAT event.
- `POST /:id/revert`: optional drift-checked reversal of an applied promotion.

All approval responses must be grounded in the Live DB after transaction completion. The UI never claims queued/pending actions are deployed.

## Acceptance test before enabling

1. Verify unit tests/ITSM build and public QA26 boundary suite.
2. Apply migrations only in an isolated release test first. Confirm the Custom QA26 UAT source event appears in Live preview, with `Show milestones: On → Off`.
3. Select that single UAT event with a test administrator and approve. Verify Live's `projects.showMilestones` changed, all other settings unchanged, no People/RMM changes, and two audit trails (Live configuration history and approval history).
4. Reopen view: candidate is now **Promoted**, not ready again. Repeated POST for same event returns conflict.
5. After a deliberate, separate Live edit of that same field, ensure the old reversal is disabled/409. When no edit intervenes, a reversal must restore only that field and record the actor.
6. Change the setting independently in Live to UAT's desired value: it must show **Already matches Production** with no duplicate write.
7. Confirm Managed tenants cannot list, approve or revert UAT settings; unrelated tenant IDs, non-admin accounts, stale event IDs and arbitrary secret-bearing paths all fail.
8. Verify mobile layouts and accessibility on iPhone; backup/restore and rollback/CI release gates must remain healthy.

This branch only builds the workflow. Production data changes are **not** part of the implementation approval.

## QA26 UAT acceptance and Live-release separation — 15 October 2026

**Confirmed QA:** Test and UAT API/ITSM run pinned `qa26-pr69-32747727ecb96f72b2ba4dbbc500fadf3be1df81`. Public boundary tests passed 12/12, QA operator confirmed authenticated Test/People access, and Custom UAT produced one append-only `delta-v2` event for `projects.showMilestones`, **On → Off**, without recording a second event after a no-op save. Read-only PostgreSQL verification showed current Custom UAT `false`, while Live has no stored value and uses the documented default `true`. The immutable UAT source event is `2001e6e0-940b-470a-9b0a-c958c4826b80`.

**Not yet available on Live:** The public selective comparison route currently returns 404; the official immutable Production-target API/ITSM image set has not been released, and Live migrations 155/156/157 have not run. The PR is not merged; shared API/ITSM release must not use QA-only tags or assume a `main` merge authorises a host cutover. See `docs/one-click-uat-production-promotion.md` for the required official-image staging, UAT exact-build attestation, platform-executor and shared Production rollback gates.

**After Live code release, before any mutation:** The Custom QA26 owner/admin should open the read-only comparison and see the latest `projects.showMilestones` proposal as `Ready`, with Live **On**, UAT **Off**. Recheck tenant/role isolation, stale/conflicting source protection and no secret-bearing paths. Clicking **Promote this setting** changes real Live configuration and requires a separate, explicit customer approval. A successful software deployment must never auto-promote that event.
