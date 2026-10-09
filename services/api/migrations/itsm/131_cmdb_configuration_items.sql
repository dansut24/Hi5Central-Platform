CREATE TABLE IF NOT EXISTS cmdb_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference text NOT NULL,
  name text NOT NULL,
  ci_type text NOT NULL DEFAULT 'Other',
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'In maintenance', 'Retired', 'Planned')),
  criticality text NOT NULL DEFAULT 'Medium' CHECK (criticality IN ('Low', 'Medium', 'High', 'Critical')),
  environment text NOT NULL DEFAULT 'Production',
  service text NOT NULL DEFAULT '',
  owner_name text NOT NULL DEFAULT '',
  owner_team text NOT NULL DEFAULT '',
  site text NOT NULL DEFAULT '',
  manufacturer text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  serial_number text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  linked_device_id text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, reference)
);
CREATE INDEX IF NOT EXISTS cmdb_items_tenant_status_idx ON cmdb_items(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS cmdb_items_tenant_type_idx ON cmdb_items(tenant_id, ci_type, name);
CREATE TABLE IF NOT EXISTS cmdb_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES cmdb_items(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES cmdb_items(id) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'Related to',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  UNIQUE(tenant_id, source_id, target_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS cmdb_relationships_target_idx ON cmdb_relationships(tenant_id, target_id);
CREATE TABLE IF NOT EXISTS cmdb_record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ci_id uuid NOT NULL REFERENCES cmdb_items(id) ON DELETE CASCADE,
  record_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, ci_id, record_reference)
);
CREATE INDEX IF NOT EXISTS cmdb_record_links_record_idx ON cmdb_record_links(tenant_id, record_reference);
