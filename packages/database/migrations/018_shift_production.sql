-- Production by shift: the plant's shift calendar, the machine states derived from the piece
-- counter and the automatic bit, and immutable shift reports.
--
-- Sensitive numbers, so three rules hold throughout:
--  * Shifts belong to the plant (site). Without any, the platform assumes one shift, Monday to
--    Friday, 07:00-17:00 (packages/shared/src/shifts.ts). Pauses are excluded from planned time.
--  * The ingestor accumulates production and state time in 5-minute buckets as messages
--    arrive; nothing is recomputed from raw samples, so a board or a report stays cheap.
--  * When a shift ends its numbers are written once into shift_reports. Editing the calendar
--    later changes only future shifts: the history is never rewritten.

CREATE TABLE IF NOT EXISTS site_shifts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, site_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
 weekdays smallint[] NOT NULL
   CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
 start_time text NOT NULL CHECK(start_time ~ '^([01][0-9]|2[0-3]):[0-5][05]$'),
 end_time text NOT NULL CHECK(end_time ~ '^([01][0-9]|2[0-3]):[0-5][05]$'),
 breaks jsonb NOT NULL DEFAULT '[]'::jsonb,
 sort_order smallint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS site_shifts_site ON site_shifts(site_id,sort_order);

-- Which variables drive the shift accounting of a device, and its optional target.
-- blocks_tag_id (pieces) and pallets_tag_id already exist (migration 012).
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS auto_tag_id uuid;
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS idle_seconds integer NOT NULL DEFAULT 60
  CHECK(idle_seconds BETWEEN 5 AND 3600);
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS target_metric text
  CHECK(target_metric IN ('milheiros','tons','blocks','pallets'));
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS target_per_shift double precision
  CHECK(target_per_shift > 0);
DO $$ BEGIN
  ALTER TABLE production_settings ADD CONSTRAINT production_settings_auto_tag_fk
    FOREIGN KEY(tenant_id,device_id,auto_tag_id) REFERENCES tags(tenant_id,device_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5-minute buckets written by the ingestor: production deltas and seconds in each state.
CREATE TABLE IF NOT EXISTS production_buckets (
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, bucket timestamptz NOT NULL,
 product_code text NOT NULL,
 pieces double precision NOT NULL DEFAULT 0, pallets double precision NOT NULL DEFAULT 0,
 tons double precision NOT NULL DEFAULT 0,
 producing_s double precision NOT NULL DEFAULT 0, idle_s double precision NOT NULL DEFAULT 0,
 manual_s double precision NOT NULL DEFAULT 0,
 PRIMARY KEY(device_id,bucket,product_code),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE
);

-- Where the ingestor left each device: survives restarts so no piece is counted twice.
CREATE TABLE IF NOT EXISTS production_runtime (
 device_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 last_at timestamptz NOT NULL, last_pieces double precision, last_pallets double precision,
 last_tons double precision, last_increment_at timestamptz, auto boolean, product_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE
);

-- Closed shifts (kind 'shift') and, per day, production outside every shift ('off_shift').
-- shift_id has no foreign key on purpose: deleting a shift must not delete its history.
CREATE TABLE IF NOT EXISTS shift_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, site_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('shift','off_shift')),
 shift_id uuid, shift_name text NOT NULL, production_date date NOT NULL,
 planned_start timestamptz NOT NULL, planned_end timestamptz NOT NULL,
 planned_seconds integer NOT NULL,
 pieces double precision NOT NULL, pallets double precision NOT NULL, tons double precision NOT NULL,
 producing_s double precision NOT NULL, idle_s double precision NOT NULL,
 manual_s double precision NOT NULL, offline_s double precision NOT NULL,
 target_metric text, target_value double precision,
 products jsonb NOT NULL DEFAULT '[]'::jsonb,
 closed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(device_id,kind,planned_start),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shift_reports_device_date ON shift_reports(device_id,production_date DESC);

ALTER TABLE dashboard_widgets DROP CONSTRAINT dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal','shift_board'
  ));

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.site_shifts, public.production_buckets, public.production_runtime, public.shift_reports FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.site_shifts, public.production_buckets, public.production_runtime,
  public.shift_reports FROM PUBLIC;
