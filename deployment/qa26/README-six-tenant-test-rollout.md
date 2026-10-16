# QA26 — certified six-tenant Test rollout (2026-10-16/17)

**Release:** `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0`.
**Scope:** Six known QA ITSM **Test** tenants only. This is not a general
production release feature enablement. Existing Managed/Custom Production
approval rules remain unchanged. **The global release pause must stay true.**

## Current qualification and non-authorisation

- Five required GitHub checks pass on the reviewed PR SHA.
- Immutable Test API and ITSM image pair are staged and healthy.
- All six Test Caddy route preflights pass. Exact sequential multi-route
  prepare, validate and reverse-restore tests pass.
- All 13 focused scoped-queue and independent audit verifier tests pass.
- **Do not mistake these results for actual customer upgrade certification.**
  The six real jobs remain `scheduled` with zero attempts.
- A restricted `hi5_release_qa_canary` DB role and its host-only 0400 file
  have **not been provisioned**. No job permits have been armed.
- Previous tool safety controls rejected modifying the privileged DB-role
  provisioning file; **do not evade those controls**, reuse the original
  release worker's credentials, or run its current over-broad SQL grants.

## Mandatory human security approval, BEFORE timers

An authorised GitHub/host administrator must review a correction to
`deployment/qa26/provision-single-test-canary-db-admin.sh`.
The script must not grant `USAGE ON ALL SEQUENCES IN SCHEMA public`;
the canary requires `USAGE` only for
`public.tenant_release_rollout_events_id_seq`. Review its table/column
privileges as well, and ensure it cannot UPDATE
`platform_release_rollout_control` or hold any high-privilege role.
The corrected provisioning change must be reviewed via the legitimate
GitHub security/administrator process before use.

The separate code-level control
`deployment/qa26/check-six-qa-test-credential-readiness.mjs`
will refuse deployment unless the live database role has **exactly one**
permitted public sequence, cannot update the global pause, is non-superuser,
and its host-only credential file has safe permissions.

## Reviewed operator sequence (root SSH; only AFTER approval)

Run the following **only after** the reviewed and committed DB provisioning
script has been approved and its scope verified. Never run the old version.

1. Check out the exact reviewed, fully green PR commit in
   `/root/hi5central-release-provisioning`.
2. Set `H5C_CANARY_REVIEWED_SHA` to that exact `git rev-parse HEAD`.
3. Verify the old `GRANT USAGE ON ALL SEQUENCES` statement is absent.
4. Provision using the approved
   `deployment/qa26/provision-single-test-canary-db-admin.sh`.
5. Run `node deployment/qa26/check-six-qa-test-credential-readiness.mjs`
   and require a pass. It prints no password.
6. Stage the exact pinned image via
   `bash deployment/qa26/stage-reviewed-six-qa-worker-admin.sh`.
7. While **before 2026-10-16 14:02 BST**, install the two one-time timers:
   `bash deployment/qa26/install-reviewed-six-qa-test-timers-admin.sh`.
   Installation fails without the restricted credential, staged image,
   immutable checkout or proper time. It never turns off the global pause.

The two one-time host-owned timers are:

| Local time (Europe/London) | Allowed job order |
| --- | --- |
| 2026-10-16 14:02 BST | h5c-managed-qa26, then h5c-custom-qa26 |
| 2026-10-17 02:02 BST | managed1, managed2, custom1, custom2 |

Each window's runner obtains an exact one-use, 45-minute staff-certified
permit for **one** known Test job, executes the immutable Test worker, and
verifies its fenced database event and actual public API/ITSM SHA before
moving to the next tenant. A failed job terminates the wave. The overnight
wave requires two verified earlier canaries. No UAT/Live route changes are
authorised. No repeated automatic retries or catch-up runs outside windows.

**Audit:** `node deployment/qa26/verify-six-qa-test-rollouts.mjs --snapshot`
or use `--expect-canaries` after the first wave and `--expect-six` after
the second. Monitor the two systemd service journals and the release worker
audit page. A pending/scheduled job is not an installed upgrade.

## Recovery

If a canary fails, **stop** subsequent Test permits, keep global pause true,
and inspect the exact job, durable host route backup, watchdog and public
API/ITSM versions. Do not delete snapshots, reissue a used permit, claim a
missing audit event, restore the entire gateway over an unrelated later
route, or rerun a deployment that already committed successfully.

The Production Caddy dual-source drift remains a separate hard NO-GO for
unattended Production rollout. Custom Production always requires customer
acceptance after UAT. Managed Production requires the platform two-canary
soak gate and its maintenance-window policy.
