-- Independent Self Service broker presence is not Agent telemetry.
ALTER TABLE rmm_device_self_service
  ADD COLUMN IF NOT EXISTS broker_seen_at timestamptz;
CREATE INDEX IF NOT EXISTS rmm_device_self_service_broker_seen
  ON rmm_device_self_service(tenant_id,broker_seen_at DESC)
  WHERE enabled=true;
