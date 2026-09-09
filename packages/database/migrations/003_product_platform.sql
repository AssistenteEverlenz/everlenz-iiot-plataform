-- Product layer: stable device identity, automatic signal discovery and configurable dashboards.
ALTER TABLE devices ADD COLUMN device_code text;
UPDATE devices
SET device_code = CASE
  WHEN id = '33333333-3333-4333-8333-333333333333' THEN 'EVL-A7-0001'
  WHEN id = '44444444-4444-4444-8444-444444444444' THEN 'EVL-GW-0001'
  ELSE 'EVL-' || upper(substr(replace(id::text, '-', ''), 1, 10))
END
WHERE device_code IS NULL;
ALTER TABLE devices ALTER COLUMN device_code SET NOT NULL;
ALTER TABLE devices ADD CONSTRAINT devices_tenant_device_code_unique UNIQUE(tenant_id, device_code);
ALTER TABLE devices ADD COLUMN provisioning_status text NOT NULL DEFAULT 'configured'
  CHECK(provisioning_status IN ('draft','awaiting_connection','configured','disabled'));

CREATE TABLE device_signal_catalog (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, device_id uuid NOT NULL,
 key text NOT NULL, inferred_type text NOT NULL CHECK(inferred_type IN ('number','boolean','string')),
 sample_value jsonb, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
 occurrences bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(device_id,key), UNIQUE(tenant_id,device_id,id)
);
CREATE INDEX signal_catalog_device_seen ON device_signal_catalog(device_id,last_seen_at DESC);

CREATE TABLE dashboards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 device_id uuid, name text NOT NULL, slug text NOT NULL, description text,
 refresh_ms integer NOT NULL DEFAULT 2000 CHECK(refresh_ms BETWEEN 1000 AND 60000),
 time_window_minutes integer NOT NULL DEFAULT 60 CHECK(time_window_minutes BETWEEN 1 AND 525600),
 is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,slug), UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX dashboards_one_default ON dashboards(tenant_id) WHERE is_default=true;

CREATE TABLE dashboard_widgets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, dashboard_id uuid NOT NULL,
 device_id uuid NOT NULL, tag_id uuid,
 widget_type text NOT NULL CHECK(widget_type IN ('value','line','gauge','status','production','oee','pareto')),
 title text NOT NULL, position integer NOT NULL DEFAULT 0, width text NOT NULL DEFAULT 'medium'
   CHECK(width IN ('small','medium','large','full')),
 config jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,dashboard_id) REFERENCES dashboards(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,device_id,tag_id) REFERENCES tags(tenant_id,device_id,id) ON DELETE CASCADE,
 UNIQUE(dashboard_id,position)
);
CREATE INDEX dashboard_widgets_dashboard_position ON dashboard_widgets(dashboard_id,position);

CREATE TABLE production_settings (
 device_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nominal_tons_per_hour double precision,
 weight_per_unit_kg double precision, ideal_cycle_seconds double precision,
 planned_minutes_per_day integer CHECK(planned_minutes_per_day BETWEEN 1 AND 1440),
 total_tag_id uuid, good_tag_id uuid, reject_tag_id uuid, rate_tag_id uuid, run_status_tag_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,device_id,total_tag_id) REFERENCES tags(tenant_id,device_id,id),
 FOREIGN KEY(tenant_id,device_id,good_tag_id) REFERENCES tags(tenant_id,device_id,id),
 FOREIGN KEY(tenant_id,device_id,reject_tag_id) REFERENCES tags(tenant_id,device_id,id),
 FOREIGN KEY(tenant_id,device_id,rate_tag_id) REFERENCES tags(tenant_id,device_id,id),
 FOREIGN KEY(tenant_id,device_id,run_status_tag_id) REFERENCES tags(tenant_id,device_id,id)
);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.device_signal_catalog, public.dashboards, public.dashboard_widgets, public.production_settings FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.device_signal_catalog, public.dashboards, public.dashboard_widgets, public.production_settings FROM PUBLIC;
