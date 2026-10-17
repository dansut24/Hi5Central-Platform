# Existing tenants → generic automatic release activation (real VPS)

**Source:** PR #79 (draft), stacked on PR #76 (draft). The six existing tenants are the cohort; **do not create another tenant, synthetic signup, isolated gateway or test database** to complete this operational certification. Do not weaken tenant/Production isolation.

**Release:** `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0`. Its six Test rollouts already succeeded and are independently verified.

## Current real state (2026-10-17 09:43 BST)

- 3 Custom UAT jobs for `h5c-custom-qa26`, `custom1`, `custom2`: scheduled / 0 attempts, exact UAT host preflights PASS. They may only execute inside their individual approved maintenance windows.
- 3 Managed Live jobs for `h5c-managed-qa26`, `managed1`, `managed2`: scheduled / 0 attempts. **Live preflight BLOCKS**, since host `/opt/hi5central/deployment/Caddyfile` and `hi5central-web:/etc/caddy/Caddyfile` have different real routing/authentication content. Do not copy one over the other or relax this guard. Have the authorised gateway owner review the full diff, reconcile both sources and running Caddy API state, validate Caddy, obtain external HTTP verification and independently approve the change.
- Global `platform_release_rollout_control.paused=true` and no active jobs.
- Generic approval migration `166_generic_release_stage_approvals.sql` not present, no planning or execution approvals. **11 migration filenames are absent from `schema_migrations`**, including 155–161 and 163–166; some earlier release objects exist out-of-band, while some older ITSM heartbeat/audit/promotion objects and new Test constraints are genuinely missing. Do **not** manually label them all applied or blindly run the full migration runner.
- Existing planner + Test/UAT/Live executor containers use `hi5central` PostgreSQL **superuser**. They run the old QA allowlist images. The new generic source-attested images are staged only, not activated. Generic automation needs dedicated least-privileged, security-reviewed worker credentials and a reviewed host rollout. Never copy/reuse the QA canary credential or grant broad database permissions as a shortcut.

## Operator review, in order

1. Merge only after protected PR #76 and PR #79 review/CI approval, including Admin/API image releases and no direct branch-to-Production shortcut. Keep the global pause ON.
2. Take a current PostgreSQL backup and verified restoration plan. Review *all* 11 pending migrations and the actual schema/constraints against each SQL file. Apply genuine missing changes through the approved versioned migration process; reconcile historical ledger entries only with independently inspected exact-schema evidence. Do not mark migrations applied merely to get past a guard. Validate tables, triggers, permission grants, pending jobs and global pause after migration.
3. Have the authorised Hi5Central security administrator provision a **dedicated, non-superuser, least-privileged** generic planner identity and separate scoped executor role(s). The executor must have no UPDATE on the global pause table, no unrestricted sequences or superuser attribute, and only job-specific, audited access; gateway filesystem writes remain inside the separately reviewed host executor. This step requires review by that human administrator. This project does **not** provide a shortcut to privilege provisioning.
4. Stage reviewed and labelled planner/worker images from the exact approved commit with `deployment/qa26/stage-reviewed-generic-release-images.sh`. Verify labels/digests, full image preflight and existing public versions. Keep the paused QA workers until their replacement startup is certified.
5. Swap the old allowlisted planner/Test/UAT/Live worker services for reviewed generic images under a rollback-capable orchestration plan. Preserve network reachability and the reviewed volume/socket boundaries; planners never get Docker. Revoke old worker restart policies before attempting to unpause, otherwise old QA workers could claim queued Live jobs. **Do not activate Live worker while Caddy drift persists.**
6. Deploy reviewed Admin/API code via the normal signed release mechanism; sign in as a real authorised platform owner/admin. For the certified SHA, record a short-lived **UAT planning** approval and an independent **UAT execution** approval with evidence. Do not grant Live execution.
7. Before any unpause, run:
   ```sh
   node deployment/qa26/verify-generic-existing-tenant-readiness.mjs --stage uat --sha 9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
   ```
   Require every check PASS: no superuser, correct generic worker, migration and approvals, all 3 real UAT host preflights and zero in-flight claims. Review scheduled maintenance windows and active tenant notifications.
8. ONLY after independent operations approval and confirmation that no legacy claimant can run, use the reviewed global rollout control in a **controlled, observed UAT-only authorization window**. Live remains unapproved and stopped. Observe fenced claims, per-tenant gateway locks, public API/web SHA, watchdog state, signed verified audit rows, and automatic defer outside maintenance windows. Immediately pause and revoke UAT execution if any invariant fails; do not manually force route writes.
9. After all three Custom UAT builds are verified, each customer administrator must accept *their exact UAT build* (the UAT verified host routes produce UAT offers). Custom Production only after acceptance and a separately scheduled customer promotion. Managed Production follows the two-Test-canary gate plus each tenant delay and maintenance schedule without UAT.
10. Production remains **NO-GO** until independent Caddy dual-source reconciliation and approval, signed host rollback rehearsal, separately reviewed Production execution scope, healthy immutable images, UAT soak and customer-specific release qualification. Verify all six public API/frontend SHAs and audit trails before declaring generic automation complete.

## Operationally safe checks

```sh
cd /root/hi5central-release-provisioning
node deployment/qa26/verify-generic-existing-tenant-readiness.mjs --stage uat \
  --sha 9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
node deployment/qa26/verify-generic-existing-tenant-readiness.mjs --stage live \
  --sha 9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
```

Both checks are read-only; a non-ready result is a hard activation stop, not an invitation to bypass it. There is deliberately **no root command here that changes PostgreSQL privileges, disables drift checks, overwrites Live Caddy, or unpauses workers**.

## Completion evidence

The release is fully generic, not a one-shot special-case, only once an independently published subsequent Dev version is automatically discovered, queued idempotently under each existing customer's policy, Test-verified, Custom UAT-accepted or Managed Test-gated, applied within permitted maintenance windows, audited with correct lease fences and review actors, and rolled back on deliberate fault injection. The current six-Test result proves the first part but not the whole chain.
