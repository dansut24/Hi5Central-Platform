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

Migration: `services/api/migrations/itsm/157_itsm_configuration_promotions.sql`. Apply only to **Live** after approved backup and before releasing the new Live API. It creates one small audit table and index. UAT already uses migration `156_itsm_configuration_audit_value_summaries.sql` for its per-field event values. No schema changes are required to copy People, records or RMM.

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
