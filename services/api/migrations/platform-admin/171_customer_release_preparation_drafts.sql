-- Staff-editable release notes before the single Release to customers action.
-- Additive metadata only: does not unpause workers, seed a release, or route traffic.
CREATE TABLE IF NOT EXISTS platform_release_preparation_drafts (
  build_sha text PRIMARY KEY CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  notes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(notes)='object' AND pg_column_size(notes)<=65536
  ),
  edited_by uuid NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_release_preparation_drafts_recent
 ON platform_release_preparation_drafts(edited_at DESC);
COMMENT ON TABLE platform_release_preparation_drafts IS
 'Editable staff release notes per immutable GitHub SHA before CI-verified publication; no customer rollout permissions.';
