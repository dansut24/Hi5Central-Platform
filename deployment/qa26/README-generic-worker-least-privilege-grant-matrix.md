# Generic release worker least-privilege grant matrix — SECURITY REVIEW ONLY

Applies to PR #79; existing six customer tenants; no Production SQL was executed
to produce this design. Do not copy grants from this page into a live shell.
It records the exact application statements requiring rights and identifies
the functions/row guards that must exist before accounts can be provisioned.

## Exact authenticated service logins

| Service | Required PostgreSQL LOGIN | Host privileges |
| --- | --- | --- |
| Planner | hi5_release_generic_planner | No Docker, no gateway, no SSH |
| Test executor | hi5_release_generic_exec_test | Reviewed Test-only host action |
| UAT executor | hi5_release_generic_exec_uat | Reviewed UAT-only route action |
| Live executor | hi5_release_generic_exec_live | MUST REMAIN DISABLED while Caddy drift exists |

Names above are now checked at application startup along with session_user ==
current_user, NO SUPERUSER, NO CREATEDB, NO CREATEROLE, NO BYPASSRLS,
NO direct UPDATE on platform_release_rollout_control. Planner must NOT
have EXECUTE on the audited emergency-pause procedure; executors must.
All roles must have bounded, separately rotated secrets using an approved
secret-management mechanism. Never store DSNs in source, PRs or logs.

## Planner direct SQL access requirements

| Permission | Relation |
| --- | --- |
| SELECT | tenants, tenant_settings, tenant_release_preferences |
| SELECT | hi5central_published_release_notes, platform_certified_application_releases |
| SELECT | tenant_release_rollout_jobs, tenant_release_rollout_events |
| SELECT | tenant_runtime_update_offers, platform_release_canary_tenants |
| SELECT | platform_release_test_qa_gates, platform_release_generic_stage_approvals |
| INSERT and narrowly scoped UPDATE | tenant_release_rollout_jobs |
| INSERT | tenant_release_rollout_events, platform_release_fanout_events |
| INSERT and narrowly scoped UPDATE | platform_release_fanout_checkpoints |
| EXECUTE reviewed verifier only | public.hi5_release_record_verified_test_gate(text,integer), not QA-gate INSERT |

**Implemented in draft PR #79, not deployed:** migration 168 adds the
revoked-from-PUBLIC SECURITY DEFINER function
public.hi5_release_record_verified_test_gate(text,integer). Generic fanout
now invokes it instead of direct QA-gate INSERT. The function rechecks the
actual human-certified published release, distinct designated Test jobs,
matching immutable verified fence and at least 30 minutes of real soak.
Do not grant any planner direct QA-gate INSERT/UPDATE. The function's SECURITY
DEFINER owner and EXECUTE grants require security review before deployment.

## Executor SQL access requirements (one role PER stage)

| Permission | Relation |
| --- | --- |
| SELECT | platform_release_rollout_control (no direct UPDATE) |
| SELECT | tenants, tenant_settings, tenant_release_preferences |
| SELECT | platform_certified_application_releases, platform_release_generic_stage_approvals |
| SELECT | platform_release_test_qa_gates, tenant_release_rollout_jobs/events |
| SELECT | tenant_runtime_update_offers/assignments/route_attestations |
| SELECT | platform_runtime_pools, platform_release_gateway_owners |
| INSERT and fenced UPDATE | tenant_release_rollout_jobs, tenant_release_rollout_events |
| INSERT/UPDATE/DELETE fenced owner | platform_release_gateway_owners |
| INSERT and UPDATE self-heartbeat | platform_release_worker_heartbeats |
| INSERT/UPDATE verified pool metadata | platform_runtime_pools |
| INSERT/UPDATE staged/verified route metadata | tenant_runtime_assignments, tenant_runtime_route_attestations |
| INSERT/UPDATE approved update-offer workflow | tenant_runtime_update_offers |
| EXECUTE only, never table UPDATE | public.hi5_release_emergency_pause(text,text) |

Application-level predicates and the worker's RELEASE_GATEWAY variable are
**not** a database security boundary. Cross-stage reads/edits must be
separately prevented by scoped RLS policies or reviewed database functions
that check session_user and every affected row. Granting table-wide UPDATE
without this protection is NOT sufficient least privilege.

The current UAT job legitimately stages a Live candidate container and may
create a pending Live offer WITHOUT changing a Live route. This cross-stage
metadata exception needs explicit, narrow review. A generic UAT credential
must never gain the power to mark a Live route active or bypass a customer
acceptance. Confirm using negative tests that its direct data access cannot
modify Live route assignments or attestations. Avoid creating policies that
accidentally restrict the existing QA canary/legacy roles or break the API.

## Host executor boundary

The Docker-socket host writer separately reads the control-plane database
through docker exec of hi5central-postgres and the database container's
POSTGRES_USER for a fenced lease and durable verification check. This is an
intentionally privileged *host* boundary, not evidence that the generic
executor has least-privileged access all the way through the deployment.
Security owner must review how the host agent obtains an independent
read-only verifier credential and ensure Docker cannot be reached from the
planner. Never mount an unrestricted Docker socket into the API frontend.

## Certification gate before credentials or UAT activation

1. Independently approved Production schema history remediation and a
   verified restore checkpoint. Stage approvals migration 166, pause migration
   167, verified Test gate migration 168 and all genuinely missing historical changes installed.
2. Security-reviewed per-table/column permissions with actual stage and
   row restrictions; no broad default grants, no GLOBAL UPDATE, no QA-gate
   forgery; separate audited secret issuance.
3. Disposable PostgreSQL17 CI proving ALL allowed code-path transactions
   execute under each actual restricted role and every cross-stage
   write/unpause/approval-forgery attempt is rejected.
4. Labelled images from protected, reviewed source; non-superuser startup
   positive/negative checks and rollback procedure.
5. Stop/restrict old QA worker restart policies before enabling any generic
   claimant; retain a reviewed fallback and compare versions/sha.
6. Independent UAT planning and execution approvals for the exact SHA,
   tenant maintenance windows and actual UAT host preflights. Live
   remains disabled and unapproved until Caddy drift is reconciled.

**Current state:** not all required DB authorization and host-boundary tests
are implemented, so this is a design for human review, not deployable grants.
