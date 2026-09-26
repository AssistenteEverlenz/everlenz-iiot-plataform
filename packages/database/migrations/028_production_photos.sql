-- Shift photos: what the history shows for a closed shift, day or off-shift day (the board, the
-- charts period by period with every pallet, and the counter minute by minute), written once
-- while its readings still exist. The history reads the photo, so the readings of a closed
-- period can be discarded after the grace period (apps/api/src/retention.ts).
CREATE TABLE IF NOT EXISTS production_photos (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shift', 'day', 'off_shift')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  production_date date NOT NULL,
  photo jsonb NOT NULL,
  bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, kind, period_start),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.production_photos FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.production_photos FROM PUBLIC;
-- Applied by hand as another role (the Supabase SQL editor), the platform's role still needs it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') AND current_user <> 'everlenz_iiot_app' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_photos TO everlenz_iiot_app;
  END IF;
END $$;
