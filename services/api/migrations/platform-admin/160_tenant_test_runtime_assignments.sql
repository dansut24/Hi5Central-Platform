-- Expand existing version-aware routing metadata to include per-tenant
-- TEST assignments. The old schema only allowed UAT/Live, making it
-- impossible to honour different tenants' Test maintenance windows.
-- No routing generation is activated and no customer traffic changes.
ALTER TABLE tenant_runtime_assignments
  DROP CONSTRAINT IF EXISTS tenant_runtime_assignments_environment_check;
ALTER TABLE tenant_runtime_assignments
  ADD CONSTRAINT tenant_runtime_assignments_environment_check
  CHECK(environment IN ('test','uat','live')) NOT VALID;
ALTER TABLE tenant_runtime_assignments
  VALIDATE CONSTRAINT tenant_runtime_assignments_environment_check;

ALTER TABLE tenant_runtime_update_offers
  DROP CONSTRAINT IF EXISTS tenant_runtime_update_offers_environment_check;
ALTER TABLE tenant_runtime_update_offers
  ADD CONSTRAINT tenant_runtime_update_offers_environment_check
  CHECK(environment IN ('test','uat','live')) NOT VALID;
ALTER TABLE tenant_runtime_update_offers
  VALIDATE CONSTRAINT tenant_runtime_update_offers_environment_check;

ALTER TABLE tenant_runtime_route_attestations
  DROP CONSTRAINT IF EXISTS tenant_runtime_route_attestations_environment_check;
ALTER TABLE tenant_runtime_route_attestations
  ADD CONSTRAINT tenant_runtime_route_attestations_environment_check
  CHECK(environment IN ('test','uat','live')) NOT VALID;
ALTER TABLE tenant_runtime_route_attestations
  VALIDATE CONSTRAINT tenant_runtime_route_attestations_environment_check;

ALTER TABLE platform_runtime_route_generations
  DROP CONSTRAINT IF EXISTS platform_runtime_route_generations_environment_check;
ALTER TABLE platform_runtime_route_generations
  ADD CONSTRAINT platform_runtime_route_generations_environment_check
  CHECK(environment IN ('test','uat','live')) NOT VALID;
ALTER TABLE platform_runtime_route_generations
  VALIDATE CONSTRAINT platform_runtime_route_generations_environment_check;

-- Keep the legacy Test pool fallback in place until the protected host agent
-- actually verifies and switches tenant-specific route generations.
