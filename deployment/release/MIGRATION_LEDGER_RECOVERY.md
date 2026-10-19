# Existing Hi5Central database migration-history recovery — evidence only

On 19 October 2026, before activating Customer Production rollback, all
four PostgreSQL databases had populated application schemas but empty
`schema_migrations` tables. The standard migration runner now **refuses**
to replay historical migrations against such a database (PR #119).

This document and the accompanying reporter DO NOT grant permission to replay
migrations or claim historic SQL execution. It is a read-only review path.

## Stage-specific evidence (19 October 2026)

Counts are of source-file declarations of CREATE TABLE/INDEX/FUNCTION and
matching currently named PostgreSQL catalogue objects; not a claim of migration
execution and not a full equivalence check of columns, constraints or indexes.

| Database | References present / 509 | Ledger rows |
| --- | ---: | ---: |
| `hi5central` (Live control) | 498 | 0 |
| `hi5central_dev` | 493 | 0 |
| `hi5central_test` | 496 | 0 |
| `hi5central_uat` | 496 | 0 |

Eight missing objects are expected because migrations 178–180 have **not**
been applied anywhere. Three older Production indexes are absent by those
historical names, with newer indexes observed:
- 031 original `tenant_microsoft_directory_tenant_unique` (globally unique
  directory ID) became `tenant_microsoft_connection_directory_unique`
  (tenant-scoped directory key). Do NOT recreate the historical global index.
- 057 original `rmm_agent_jobs_vendor_artifact_probe_idx` became the
  `rmm_agent_jobs_vendor_artifact_inspect_idx` for the newer inspection job.
- 091 original `rmm_windows_patch_active_job_uniq` is not present. The
  contemporary Windows Update 'manage' and 'rollback' flows have separate
  active-job indexes. Do NOT recreate the older index without checking
  current job semantics.

Additional stage-specific differences:
- Dev lacks several 174 submission/handoff and 175 Managed Live pilot objects.
- Test and UAT lack the 175 Managed Live Production pilot objects.
- Therefore no single Production-derived SQL baseline or migration history
  may be assumed to apply to all environments.

## Verified recovery evidence

A private PostgreSQL custom-format full-data backup of the Live control
database was taken before any DDL. It was checked with `pg_restore -l`,
then restored into a PostgreSQL 17 container with **no network or host port**.
Its 216 public tables, ten release jobs and zero-row ledger were independently
confirmed. The container was destroyed after validation.

On another disposable restore, migrations 178–180 compiled against this actual
schema; the new dedicated role remained NOLOGIN, with no direct customer table
writes and no seeded rollback approvals. The real Live DB was NOT changed.

Root-only evidence and backup currently reside under:
`/opt/hi5central/recovery/customer-rollback-activation-20261019-1919/`

These host paths are recovery references, not checked-in fixtures. Do not
publish backup bytes, connection strings, secrets, or customer records.

## Reviewing baseline equivalence (required before activation)

1. Run `node services/api/src/reportMigrationBaseline.mjs --report` with
   the appropriate database's **read-only** credential. Each database must be
   inspected independently. The reporter records file hashes and object
   names only; it performs no DDL/DML and always returns
   `status: HISTORY_UNVERIFIED`.
2. Review schema **semantics**, not only object presence: columns,
   constraints, RLS policies, stage-specific grants, active indexes, required
   security-definer functions, and exact content fingerprints. Account for
   later replacements and intentional stage differences.
3. Obtain **named, independently reviewed, per-database authorisation** of
   the reconstructed schema baseline against source revision and backup.
   Treat it as a new explicit attestation of present-day *schema equivalence*,
   NOT as evidence that each historical migration script executed.
4. Develop/review a baseline-aware migration mechanism that can recognise
   that explicit attestation and apply **only** the newly approved suffix
   (178–180 initially). It must preserve the historical zero-row ledger and
   maintain separately audited receipts for new SQL actually executed,
   without allowing the generic runner to mistake a partial ledger for
   history completeness.
5. Test backup restoration, negative stage/role cases, transaction rollback,
   worker fail-closed status, UAT release gates, and exact Production
   customer-isolation gates before enabling the worker.
6. Do not fake customer rollback approvals, activate the new worker, or
   reload the shared gateway to compensate for migration-history problems.

## Unsafe shortcuts — prohibited

- **Do not** insert 175 migration names into `schema_migrations` solely
  because most SQL object names exist.
- **Do not** use `migrate.js` against a populated zero-ledger database.
- **Do not** apply migrations 178–180 manually and record only those three
  filenames as historical entries; this creates a non-contiguous ledger.
- **Do not** copy the Production baseline to Dev, Test or UAT.
- **Do not** enable `H5C_CUSTOMER_ROLLBACK_EXECUTOR_READY` or worker
  activation flags before independent reviewer certification.
