-- Developer-authored release notes remain private until Hi5Central explicitly
-- publishes them. No raw Git history, tenant data or unreleased notes are
-- distributed through the customer changelog.
CREATE TABLE IF NOT EXISTS hi5central_release_note_drafts (
  build_sha text PRIMARY KEY CHECK (build_sha ~ '^[0-9a-f]{40}$'),
  version_label text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','publication_requested','published')),
  edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  edited_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz,
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS hi5_release_note_pending_idx ON
  hi5central_release_note_drafts(requested_at)
  WHERE status='publication_requested';

-- Only the central Live release authority serves these customer-visible
-- records. Dev/UAT fetch that authority's public catalogue, never local drafts.
CREATE TABLE IF NOT EXISTS hi5central_published_release_notes (
  build_sha text PRIMARY KEY CHECK(build_sha ~ '^[0-9a-f]{40}$'),
  version_label text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  entries jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hi5central_published_release_notes_recent_idx
  ON hi5central_published_release_notes(published_at DESC);
