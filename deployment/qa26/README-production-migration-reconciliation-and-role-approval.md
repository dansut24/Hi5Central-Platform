# Production migration and worker identity review (2026-10-17)

Scope: real six Hi5Central tenants, certified build 9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0.
This document is operational evidence, NOT authorisation for DDL, credential changes or deployment.
PR #79 remains draft. The global rollout must remain paused.

## Live read-only evidence

- All six Test jobs have succeeded. Three Custom UAT and three Managed Live jobs are scheduled.
- The live rollout pause remains true, with zero active deployment jobs.
- The existing planner and Test/UAT/Live workers connect as the hi5central PostgreSQL superuser.
- The independent hi5_release_qa_canary identity must not be reused or expanded for generic deployment.
- Eleven repository migration filenames are absent from the production schema_migrations ledger.

## Migration-by-migration reconciliation

| File | Observed database objects | Disposition |
| --- | --- | --- |
| 155_app_release_executor_heartbeat.sql | Heartbeat table absent | Real new DDL; reviewed migration required |
| 156_itsm_configuration_audit_value_summaries.sql | value_changes column absent | Real new DDL; review constraints and compatibility |
| 157_itsm_configuration_promotions.sql | Promotions table absent | Real new DDL; reviewed migration required |
| 158_tenant_release_rollout_jobs.sql | Jobs/events/pause tables and named indexes exist | Out-of-band structures; full DDL comparison before ledger repair |
| 159_platform_release_test_qa_gates.sql | QA gates table exists; later automatic-canary check present | Compare full definitions; do not regress later QA gate |
| 160_tenant_test_runtime_assignments.sql | Four environment constraints still allow only UAT/Live | Genuine constraint update; review validation and locks |
| 161_release_rollout_blackouts.sql | blackout_periods, expected_duration_minutes and blackout constraint exist | Compare complete column/default/check definitions |
| 163_certified_release_fanout.sql | Certification/checkpoint/event tables and named indexes exist | Full DDL comparison before ledger repair |
| 164_automatic_verified_test_canaries.sql | Canary table/index and automatic QA check exist | Compare check, FK, defaults and index definitions |
| 165_single_paused_test_canary.sql | Permit table and single-armed index exist | Compare constraints, grants and audit lineage |
| 166_generic_release_stage_approvals.sql | Both approval tables absent | New default-deny stage approval migration required |
| 167_release_emergency_pause_least_privilege.sql | New PR #79 migration, not installed | Adds audited pause-only function, does not grant it to any role |

Table/index presence is not proof of schema equivalence. Check all columns, types, nullability,
constraints, indexes, FKs, triggers, ACLs, defaults, owner, policy and data dependencies for
each migration before reconciling history. Do not mark absent ledger entries as applied
merely to make the migration runner succeed.

## Reviewed sequence

1. Obtain independent human approval, current verified PostgreSQL backup and restoration evidence.
2. Compare existing objects with every pending SQL file, preserving later out-of-band constraints.
3. Create a versioned reviewed history reconciliation only for proven equivalent structures.
4. Apply genuinely missing changes using the approved migration mechanism with transaction and rollback checks.
5. Verify the schema_migrations ledger, real queue, stage audit trigger, no generic grants, and global pause.
6. Provision credentials only through a separate security review, then run real connection-level privilege tests.

## Required role boundaries

- The generic planner has scheduling-only database privileges; no Docker socket, no global pause UPDATE, and no emergency-pause function grant.
- Use separate non-superuser logins for Test, UAT and Live executors. Enforce stage access at the database boundary, not only by environment variables.
- No role may have SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS, table ownership, blanket grants or unrestricted sequence access.
- Explicitly grant the reviewed executor roles EXECUTE on public.hi5_release_emergency_pause(text,text), created by migration 167.
- This function can only set paused=true and writes an audit event. It cannot unpause. No worker receives UPDATE privilege on the pause-control table.
- Do not reuse existing QA credentials. Do not print or commit credentials or connection strings.

Expected live role-probe: superuser=false; direct rollout-control UPDATE=false;
emergency function EXECUTE=true for executors and false for planner.
The existing-tenant readiness check now requires these protections.
A disposable PostgreSQL CI test verifies the function and denied unpause.

## Independent Live Caddy source drift

Read-only source SHA256: disk 8a04056fc756cff98c71030a1404cede32ef85252ff1ea012f7e86c1515df1b3;
mounted running gateway 21657cd198a1e1da167083faad432ac7f66ecd964190b5d75c18acb7fda4e050.
The two files differ in host text and counts of proxy, handle, header, redirect and response directives.
Some extra disk hostname occurrences may be comments; a full semantic diff and running API config review is required.
Do not copy either file over the other, reload the gateway or disable drift checks.

## Hold points

Custom UAT may proceed only after reviewed schema, scoped credentials, reviewed images,
stage planning AND separate execution approval, independent preflight and controlled
observed activation in each tenant maintenance window.
Managed Production requires separate QA evidence and independently reconciled Live gateway sources.
No migration, role, approval, tenant route or worker was changed by this review.
