-- Environment identity inventory only. UAT/Test are NOT data partitions yet.
-- 'pending' deliberately denies routing until isolated storage/session/agent
-- scopes are provisioned and independently verified.
CREATE TABLE IF NOT EXISTS tenant_environment_instances (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('live','uat','test')),
  hostname_label text NOT NULL UNIQUE,
  provisioning_status text NOT NULL DEFAULT 'pending'
    CHECK (provisioning_status IN ('pending','provisioning','ready','suspended','failed')),
  isolation_reference text,
  isolation_verified_at timestamptz,
  active_release_ref text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,environment),
  CONSTRAINT sandbox_requires_verified_isolation CHECK (
    environment = 'live'
    OR provisioning_status <> 'ready'
    OR (NULLIF(isolation_reference,'') IS NOT NULL AND isolation_verified_at IS NOT NULL)
  ),
  CONSTRAINT hostname_label_format CHECK (hostname_label ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

-- Reserve the already-existing production hostname first. Do not modify
-- tenant settings or create separate databases as part of this migration.
INSERT INTO tenant_environment_instances
  (tenant_id,environment,hostname_label,provisioning_status)
SELECT id,'live',slug,'ready'
FROM tenants
ON CONFLICT DO NOTHING;

-- Reserve customer sandboxes only when there is no existing tenant whose
-- production slug would conflict with the requested hostname.
INSERT INTO tenant_environment_instances
  (tenant_id,environment,hostname_label,provisioning_status)
SELECT t.id,e.environment,t.slug || e.suffix,'pending'
FROM tenants t
CROSS JOIN (VALUES ('uat','uat'),('test','test')) AS e(environment,suffix)
WHERE length(t.slug || e.suffix) <= 63
  AND NOT EXISTS (SELECT 1 FROM tenants collision WHERE collision.slug=t.slug || e.suffix)
  AND t.slug NOT IN ('admin','api','dev','test','uat')
  AND t.slug !~ '(uat|test)$'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION reserve_tenant_environment_hostnames()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_environment_instances
    (tenant_id,environment,hostname_label,provisioning_status)
  VALUES (NEW.id,'live',NEW.slug,'ready')
  ON CONFLICT DO NOTHING;

  IF NEW.slug NOT IN ('admin','api','dev','test','uat')
      AND NEW.slug !~ '(uat|test)$' THEN
    INSERT INTO tenant_environment_instances
      (tenant_id,environment,hostname_label,provisioning_status)
    VALUES
      (NEW.id,'uat',NEW.slug || 'uat','pending'),
      (NEW.id,'test',NEW.slug || 'test','pending')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_environment_hostname_reservation ON tenants;
CREATE TRIGGER tenants_environment_hostname_reservation
AFTER INSERT ON tenants FOR EACH ROW
EXECUTE FUNCTION reserve_tenant_environment_hostnames();

COMMENT ON TABLE tenant_environment_instances IS
  'Reservation/provisioning inventory. Never route UAT/Test to production tenant data merely because a row exists.';
