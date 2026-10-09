CREATE TABLE IF NOT EXISTS user_experience_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_login_completed_at timestamptz,
  platform_guidance jsonb NOT NULL DEFAULT '{}'::jsonb,
  platform_getting_started jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO user_experience_preferences (
  user_id,
  preferences,
  first_login_completed_at,
  platform_guidance,
  platform_getting_started,
  created_at,
  updated_at
)
SELECT DISTINCT ON (up.user_id)
  up.user_id,
  COALESCE(up.preferences, '{}'::jsonb),
  up.first_login_completed_at,
  CASE
    WHEN up.coachmarks_completed_at IS NOT NULL
      THEN jsonb_build_object('itsm', jsonb_build_object('completedAt', up.coachmarks_completed_at))
    ELSE '{}'::jsonb
  END,
  CASE
    WHEN up.getting_started_dismissed_at IS NOT NULL
      THEN jsonb_build_object('itsm', jsonb_build_object('dismissedAt', up.getting_started_dismissed_at))
    ELSE '{}'::jsonb
  END,
  up.created_at,
  up.updated_at
FROM user_preferences up
ORDER BY up.user_id, up.updated_at DESC
ON CONFLICT (user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS user_experience_preferences_updated_idx
  ON user_experience_preferences(updated_at DESC);
