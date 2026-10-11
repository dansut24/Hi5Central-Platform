-- Automatic UAT configuration-change journal. Triggered by database writes,
-- not by a special button or a feature-specific frontend handler.
-- Values, secrets, credentials and test records are never copied into the journal.
CREATE TABLE IF NOT EXISTS tenant_configuration_change_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  source_key text NOT NULL DEFAULT '',
  changed_path text[] NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert','update','delete')),
  actor_user_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_config_changes_tenant_idx
  ON tenant_configuration_change_events(tenant_id,recorded_at DESC,id DESC);

CREATE OR REPLACE FUNCTION hi5_config_changed_paths(
  previous jsonb, next_value jsonb, parent text[] DEFAULT ARRAY[]::text[]
) RETURNS SETOF text[] LANGUAGE plpgsql AS $$
DECLARE key text;
BEGIN
  IF previous IS NOT DISTINCT FROM next_value THEN RETURN; END IF;
  IF jsonb_typeof(previous) = 'object' OR jsonb_typeof(next_value) = 'object' THEN
    FOR key IN
      SELECT item FROM (
        SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(previous)='object' THEN previous ELSE '{}'::jsonb END) item
        UNION
        SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(next_value)='object' THEN next_value ELSE '{}'::jsonb END)
      ) keys ORDER BY item
    LOOP
      RETURN QUERY SELECT change_path FROM hi5_config_changed_paths(previous->key,next_value->key,parent||key) AS changes(change_path);
    END LOOP;
  ELSE
    RETURN NEXT parent;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hi5_record_tenant_config_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_value jsonb;
  after_value jsonb;
  row_data jsonb;
  path text[];
  tenant uuid;
  source_id text;
  operation text;
  actor_text text;
  actor uuid;
BEGIN
  operation=lower(TG_OP);
  IF TG_OP='DELETE' THEN row_data=to_jsonb(OLD);
  ELSE row_data=to_jsonb(NEW); END IF;
  tenant=(row_data->>'tenant_id')::uuid;
  source_id=COALESCE(row_data->>TG_ARGV[0],'');
  IF TG_TABLE_NAME='tenant_settings' THEN
    IF TG_OP='INSERT' THEN
      before_value='{}'::jsonb;
    ELSE
      before_value=CASE WHEN OLD.configuration='{}'::jsonb
        THEN COALESCE(OLD.onboarding_data,'{}'::jsonb) ELSE COALESCE(OLD.configuration,'{}'::jsonb) END;
    END IF;
    IF TG_OP='DELETE' THEN after_value='{}'::jsonb;
    ELSE
      after_value=CASE WHEN NEW.configuration='{}'::jsonb
        THEN COALESCE(NEW.onboarding_data,'{}'::jsonb) ELSE COALESCE(NEW.configuration,'{}'::jsonb) END;
    END IF;
  ELSE
    before_value=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
    after_value=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
    before_value=before_value-'id'-'tenant_id'-'created_at'-'updated_at'-'updated_by'-'last_sync_at';
    after_value=after_value-'id'-'tenant_id'-'created_at'-'updated_at'-'updated_by'-'last_sync_at';
  END IF;
  actor_text=NULLIF(current_setting('hi5.actor_user_id',true),'');
  IF actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN actor=actor_text::uuid;
  END IF;
  FOR path IN SELECT change_path FROM hi5_config_changed_paths(before_value,after_value) AS d(change_path)
  LOOP
    INSERT INTO tenant_configuration_change_events
      (tenant_id,source_table,source_key,changed_path,operation,actor_user_id)
    VALUES (tenant,TG_TABLE_NAME,source_id,path,operation,actor);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hi5_track_tenant_settings ON tenant_settings;
CREATE TRIGGER hi5_track_tenant_settings
 AFTER UPDATE OF configuration,onboarding_data ON tenant_settings
 FOR EACH ROW EXECUTE FUNCTION hi5_record_tenant_config_change('tenant_id');

-- These are configuration *definitions*, not customer business records.
-- Additional configuration-definition tables join here, without changing
-- their save routes or frontend components. Generic events never store values.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('tenant_notification_settings','tenant_id'),
      ('live_chat_service_settings','tenant_id'),
      ('service_catalogue_items','id'),
      ('service_catalogue_categories','id'),
      ('service_catalogue_fulfilment_flows','id'),
      ('rmm_automations','id'),
      ('tenant_environment_feature_overrides','feature_key')
    ) AS sources(table_name,key_column)
  LOOP
    IF to_regclass('public.'||item.table_name) IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=item.table_name AND column_name='tenant_id')
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=item.table_name AND column_name=item.key_column)
    THEN
      EXECUTE format('DROP TRIGGER IF EXISTS hi5_track_config ON public.%I',item.table_name);
      EXECUTE format(
        'CREATE TRIGGER hi5_track_config AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION hi5_record_tenant_config_change(%L)',
        item.table_name,item.key_column
      );
    END IF;
  END LOOP;
END $$;

-- Approval history is separate from operational release binaries.
CREATE TABLE IF NOT EXISTS tenant_configuration_promotions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  items jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  promoted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_config_promotions_tenant_idx
  ON tenant_configuration_promotions(tenant_id,promoted_at DESC);

-- Generic code-capability registry: registration is release metadata, not a
-- per-screen tracking hook. Code-independent configuration needs no entry.
-- Each new application build advertises the capabilities it implements.
CREATE TABLE IF NOT EXISTS platform_build_configuration_capabilities (
  build_sha text NOT NULL CHECK(build_sha ~ '^[a-f0-9]{40}$'),
  component text NOT NULL CHECK(component IN ('api','itsm')),
  capability_key text NOT NULL CHECK(capability_key ~ '^[a-z0-9_.-]{3,120}$'),
  PRIMARY KEY(build_sha,component,capability_key)
);
CREATE TABLE IF NOT EXISTS platform_configuration_capability_requirements (
  path_prefix text[] NOT NULL PRIMARY KEY,
  capability_key text NOT NULL CHECK(capability_key ~ '^[a-z0-9_.-]{3,120}$'),
  component text NOT NULL CHECK(component IN ('api','itsm')),
  description text NOT NULL DEFAULT ''
);
