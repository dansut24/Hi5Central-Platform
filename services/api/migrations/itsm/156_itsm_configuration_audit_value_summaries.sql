-- Allowlist-filtered UI-safe value summaries for newly recorded ITSM changes.
-- NOT a snapshot; never stores secrets or arbitrary before/after JSON config.
-- Older append-only events remain unchanged with an empty summary.
ALTER TABLE itsm_configuration_change_events
  ADD COLUMN IF NOT EXISTS value_changes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE itsm_configuration_change_events
  DROP CONSTRAINT IF EXISTS itsm_configuration_change_events_values_safe_shape;
ALTER TABLE itsm_configuration_change_events
  ADD CONSTRAINT itsm_configuration_change_events_values_safe_shape
  CHECK (jsonb_typeof(value_changes)='array' AND octet_length(value_changes::text)<=12000);
