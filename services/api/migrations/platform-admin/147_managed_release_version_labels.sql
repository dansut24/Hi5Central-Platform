-- A published release may have its customer-facing version label corrected
-- by authorised Hi5Central Dev staff. This never alters immutable build SHA,
-- release notes, approval state or the deployed application.
ALTER TABLE hi5central_release_note_drafts
  ADD COLUMN IF NOT EXISTS version_sync_state text NOT NULL DEFAULT 'synced'
    CHECK (version_sync_state IN ('synced','pending')),
  ADD COLUMN IF NOT EXISTS version_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS hi5central_published_version_label_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  build_sha text NOT NULL REFERENCES hi5central_published_release_notes(build_sha),
  previous_version_label text NOT NULL,
  new_version_label text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hi5central_published_version_label_audit_latest_idx
  ON hi5central_published_version_label_audit(build_sha,changed_at DESC);
