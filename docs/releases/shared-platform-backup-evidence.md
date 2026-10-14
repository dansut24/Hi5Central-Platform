# Shared Production database backup evidence

This Admin feature distinguishes **shared platform database archives** from
**tenant-specific restore points**. A shared archive's file size must never be
described as the size of any single tenant's data, and it does not certify
Test/UAT coverage or selective tenant restore.

## Evidence policy

- Backups must be produced on an authorised host and retained with restricted
  filesystem permissions. They must never be served by the Admin frontend.
- Record actual completed archive time and file length, not an estimated size.
- Compute SHA-256 of the exact archive. PostgreSQL custom-format archives must
  pass a `pg_restore --list` check.
- `archive_list_checked` means **TOC-readable only**. It does not prove every
  data block can be restored.
- Only mark `isolated_restore_tested` after restoring the *same SHA-256 archive*
  into a fresh, disposable PostgreSQL instance at a compatible major version,
  with **network disabled, no published ports and ephemeral storage**.
  Validate essential tables and row counts, and immediately destroy the
  temporary restore target. Never print customer rows or credentials.
- Do not claim a newly onboarded tenant is covered by an older shared archive.
  The Admin API excludes snapshots from before that tenant completed onboarding.
- Do not record a tenant-specific backup under `platform_tenant_backup_records`
  unless the actual tenant-scoped artifact and restore procedure are verified.
- Off-host replication, encryption at rest, key access, retention and a periodic
  recovery exercise are separate disaster-recovery controls. A successful local
  restore test does not establish those controls.

## Database and release gate

Migration `153_shared_database_backup_evidence.sql` is additive. It creates
`platform_database_backup_evidence` and performs **no automatic backfill**.
Use the Production-approved migration operator. Unreviewed direct SQL, host
routing changes, or a new runner that sidesteps deployment approval are not
allowed.

A trusted operator may insert evidence once the migration has been approved
and applied. The record contains only: environment (`live`), shared-database
scope, archive timestamp, actual bytes, checksum, validation state and time,
restore-test time (if applicable) and an internal source label. Do not store
the archive bytes, secrets, arbitrary customer URLs or untrusted file paths
in the API.

The tenant overview reads the latest eligible Production shared archive
separately from verified tenant-specific backups. Missing evidence remains
`null`. HTML must display the restore-test state and state that Test/UAT are
not covered.

## Operational checklist

1. Review backup freshness and retention requirements with the platform owner.
2. Ensure the destination for encrypted offsite backups and recovery keys is
   configured before considering disaster recovery complete.
3. Run and attest regular archive checks and periodic isolated restore tests.
4. Apply schema and deployed API/UI via protected Production release and test
   tenant-scoped authentication, billing invariants and public smoke checks.
5. Schedule the verifier through an authorised Operations workflow, not a
   background worker running in the ordinary tenant API container.
6. Alert administrators for missing, stale or failed backups. Retain at least
   one independently tested recovery point when rotating archives.

## Pilot evidence

During an authorised 2026-10-13 pre-deployment test, an existing 34.6 MB
Production custom-format archive was inspected and restored into an isolated
PostgreSQL 17 disposable instance. The restore completed without errors and
essential catalog and tenant record checks passed. The disposable instance
was removed. This is **one observed recovery test**, not proof of a recurring
schedule or offsite protection.

The first attempted live schema change was blocked by the protected host
interface. **Do not claim the new backup evidence is visible in Production
until an approved migration and a staged API/UI cutover are completed.**
