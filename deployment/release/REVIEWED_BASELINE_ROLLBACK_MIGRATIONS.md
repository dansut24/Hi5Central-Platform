# Activation gate: only rollback migrations 178–180

**Scope:** This is a narrowly scoped migration approval gate for the missing
customer Production rollback control schema. It is not a replacement for the
Hi5Central upgrade runner. It does not repair, fabricate, or overwrite
historical migration records.

## Current state

All four current Hi5Central databases have populated schemas but zero rows
in `schema_migrations`. The normal migration runner **must remain blocked**
by PR #119. Source-object catalogue evidence is available from PR #120.

A restorable, private full Production database backup was verified in a
network-isolated PostgreSQL restore. The three exact SQL files 178–180 were
compiled against that restored live schema and never persisted to Production.

## Exact, two-reviewer process

The narrowly scoped operator provides **three explicit commands**:

- `--inspect`: read-only schema inventory fingerprint and SHA-256 hashes
  for only the exact three SQL files. Reads object definitions, roles, grants,
  policies, triggers and constraints. Does not inspect customer table rows.
- `--preflight /absolute/signed-review.json`: read-only verification of
  two separately signed Ed25519 approvals for one exact database, immutable
  source commit, schema fingerprint, backup checksum, worker revision,
  and the three SQL file hashes. Approval expires within four hours.
- `--apply /absolute/signed-review.json`: additionally needs the explicit
  `H5C_REVIEWED_BASELINE_APPLY=true` opt-in, established **DBA object owner**
  identity `hi5central`, and the checked backup. It acquires the standard
  migration advisory lock, runs exactly migrations 178, 179 and 180 in one
  transaction, creates a separate immutable receipt of SQL actually applied,
  verifies no reviews/requests were seeded, and commits only if the new worker
  identity is still NOLOGIN.

**Important PostgreSQL permission finding:** existing application tables
are owned by the established DBA account. An unrelated non-superuser with
`GRANT ALL ON TABLE` still cannot `ALTER TABLE`. The reviewed migration
uses the existing controlled DBA identity *for this one migration*; it does
not create a new superuser or elevate the long-running worker. The worker
identity created by migration 179 stays separate and NOLOGIN.

The signature trust anchors must be **root-owned and independently
provisioned** as these PEM public keys:

`/etc/hi5central/migration-review/staff-ed25519.pub.pem`

`/etc/hi5central/migration-review/dba-ed25519.pub.pem`

The reviewer and DBA sign the identical canonical JSON payload. Their keys
must differ and must be provisioned through authorised administration.
Never put their private keys or signed Live approvals in GitHub, container
images, chat, or public logs. No approvals or keys are seeded by this PR.

The payload must specify:
- `purpose: custom-customer-rollback-178-180` and `version: 1`;
- one of `live`, `dev`, `test`, or `uat` and its exact database;
- `schemaFingerprint`, `publicTableCount`, `previousLedgerRows: 0`;
- `sourceCommit`, `workerRevisionSha`, and exact 178–180 SQL checksums;
- verified private backup path + SHA-256 and `backupRestored: true`;
- explicit history-unknown, schema equivalence, stage isolation, unchanged
  customer route, and disabled worker attestations;
- different named reviewer and DBA identifiers, reason, review and expiry
  timestamps, plus both Ed25519 signatures.

**The structural fingerprint alone is not proof that historical migrations
executed.** The independent reviewers must inspect the per-stage differences,
schema semantics and exact recovery evidence before signing.

## Stage order and safety checks

1. Merge with green code review. Verify exact Dev API+frontend SHA.
2. Rehearse `--inspect` and deny cases with no review keys or without
   a signed review. Verify a real backup restore, with no public ports.
3. Independently sign a separate review for **each** stage. Use the Dev/Test
   migration review gates first; do not copy Production's schema fingerprint,
   approved backup or approval into another environment.
4. Apply only through the authorised DBA operator, never using the standard
   `migrate.js` on a zero-ledger populated database. Record the actual SQL
   receipt and retain the historical ledger unchanged.
5. Keep the dedicated worker disabled, provision a separate least-privileged
   rollback credential, and prove its table access denials.
6. Obtain authentic platform staff compatibility and worker certifications,
   pass Customer Custom UAT and customer-approved Live promotion, and only
   then conduct one genuine customer-signed Production rollback.
7. Verify the restored API, frontend, unchanged Custom UAT, other customers,
   rollback request/audit state and preserved tenant upgrade hold.

The three-file migration itself **does not roll back any customer**. No route
change, approval, worker activation or Production rollout is triggered by
merging this PR.

## Hard stop cases

Refuse a missing/mismatched/expired signature, unknown history without
independent equivalence review, stage or schema fingerprint drift, changed
backup, different SQL hashes, altered source commit, broad privileged
runtime credential, seeded approval, or any nonzero old migration ledger.

The prior live gateway mutation was blocked by host execution safety
controls. This migration work does not bypass that restriction: the actual
customer Production rollback still needs a separately authorised execution
path, genuine customer request and independent operational verification.
