-- What the platform found wrong in the production counts, and what was done about it (2026-10-31).
--
-- On 28/10 a second HMI on Cerâmica Capixaba's credential made one shift read 6 million pieces.
-- Two things now watch the counts: the ingestor refuses a counter step faster than any line can
-- run and writes it here ('refused_step'), and a check every four hours (production-audit.ts)
-- compares the stored counts with a recount of the readings and looks for impossible or late
-- buckets. Each finding says when, which counter, how much, why, and the correction proposed;
-- once corrected or accepted it keeps who did it and the values before and after.
CREATE TABLE IF NOT EXISTS production_anomalies (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  -- 'refused_step' | 'recount' | 'jump' | 'late_burst' | 'suspicious' | 'report_mismatch'
  kind text NOT NULL,
  -- 'pieces' | 'pallets' | 'tons' | 'all'
  counter text NOT NULL DEFAULT 'all',
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  production_date date,
  occurrences integer NOT NULL DEFAULT 1,
  -- How much is in question, in the counter's own unit.
  amount numeric NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'open' | 'fixed' | 'accepted'
  status text NOT NULL DEFAULT 'open',
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution jsonb,
  UNIQUE (device_id, kind, counter, window_start),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS production_anomalies_open
  ON production_anomalies(tenant_id, device_id, window_start DESC) WHERE status = 'open';

-- Applied by hand in the Supabase SQL editor, where the table comes out owned by postgres,
-- exposed to the Data API and with RLS on: give it to the platform like the others. The roles
-- do not exist in plain PostgreSQL/PGlite, hence the checks.
REVOKE ALL ON TABLE public.production_anomalies FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.production_anomalies FROM %I', role_name);
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_anomalies TO everlenz_iiot_app;
  GRANT USAGE, SELECT ON SEQUENCE public.production_anomalies_id_seq TO everlenz_iiot_app;
 END IF;
END $$;
ALTER TABLE public.production_anomalies DISABLE ROW LEVEL SECURITY;
