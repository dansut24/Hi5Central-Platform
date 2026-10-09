-- A managed UAT/Test database is not the central control plane. Creating a
-- suspended environment-local tenant must not reserve a fake "Live: ready"
-- hostname in that environment's own tenant_environment_instances table.
-- The control plane continues to reserve three customer hostnames normally.
CREATE OR REPLACE FUNCTION reserve_tenant_environment_hostnames()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM managed_runtime_database_identity
     WHERE singleton=true AND environment IN ('uat','test')
  ) THEN
    RETURN NEW;
  END IF;

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

COMMENT ON FUNCTION reserve_tenant_environment_hostnames() IS
  'Central control plane reserves managed customer hostnames. Attested UAT/Test databases do not create spurious Live-ready environment records.';
