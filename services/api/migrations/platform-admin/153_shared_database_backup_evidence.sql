-- Shared platform database backup evidence, distinct from tenant-scoped restore points.
-- Archives are checked for PostgreSQL custom-format TOC and SHA-256 before insertion.
-- TOC inspection does not establish that an isolated restore has been completed.
CREATE TABLE IF NOT EXISTS platform_database_backup_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('live','uat','test')),
  coverage text NOT NULL DEFAULT 'shared_database'
    CHECK (coverage = 'shared_database'),
  archive_created_at timestamptz NOT NULL,
  archive_bytes bigint NOT NULL CHECK (archive_bytes > 0),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  format text NOT NULL DEFAULT 'postgres_custom'
    CHECK (format = 'postgres_custom'),
  inspection text NOT NULL DEFAULT 'archive_list_checked'
    CHECK (inspection IN ('archive_list_checked','isolated_restore_tested')),
  inspected_at timestamptz NOT NULL,
  restore_tested_at timestamptz,
  source_label text NOT NULL CHECK (length(source_label) BETWEEN 3 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment,archive_sha256),
  CHECK (inspection <> 'isolated_restore_tested' OR restore_tested_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_platform_db_backup_latest
  ON platform_database_backup_evidence(environment,archive_created_at DESC);
-- No automatic backfill: record only archives inspected by an operator.
