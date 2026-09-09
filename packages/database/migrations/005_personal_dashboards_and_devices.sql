-- Per-user dashboards, searchable customer/site references and reversible device archival.
ALTER TABLE sites ADD COLUMN reference text;
UPDATE sites SET reference='CLI-' || upper(substr(replace(id::text,'-',''),1,6)) WHERE reference IS NULL;
ALTER TABLE sites ALTER COLUMN reference SET NOT NULL;
ALTER TABLE sites ALTER COLUMN reference SET DEFAULT 'CLI-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
ALTER TABLE sites ADD CONSTRAINT sites_tenant_reference_unique UNIQUE(tenant_id,reference);

ALTER TABLE devices ADD COLUMN archived_at timestamptz;
ALTER TABLE devices ADD COLUMN mqtt_username text;
ALTER TABLE devices ADD COLUMN mqtt_password text;
UPDATE devices SET mqtt_username=lower(device_code) WHERE mqtt_username IS NULL;

CREATE TABLE user_dashboard_configs (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 dashboard_id uuid NOT NULL,
 refresh_ms integer NOT NULL CHECK(refresh_ms BETWEEN 1000 AND 60000),
 time_window_minutes integer NOT NULL CHECK(time_window_minutes BETWEEN 1 AND 525600),
 widgets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(widgets)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,dashboard_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES app_users(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,dashboard_id) REFERENCES dashboards(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX user_dashboard_configs_dashboard ON user_dashboard_configs(dashboard_id,user_id);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.user_dashboard_configs FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.user_dashboard_configs FROM PUBLIC;
