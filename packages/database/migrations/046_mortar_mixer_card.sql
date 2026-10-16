-- The mixer board of a mortar plant: one card with the two processes of the mixer, the scale
-- against the recipe and the day's work curve, in place of a loose card per variable.
ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal','shift_board','stops','wear',
    'bagging','mortar_output','mortar_materials','mortar_yield','mortar_mixer'
  ));

-- Every step of the mixer's two processes, as the PLC runs them: the weighing (the scale) and
-- the mixer, independent of each other. The HMI publishes the step number of each
-- (ProcessoPesagem, ProcessoMisturador); the ingestor writes a row when a step begins and closes
-- it when the next one does. Kept for good, unlike the readings, so a step's time can be
-- compared with last week's or last month's.
CREATE TABLE IF NOT EXISTS mortar_process_steps (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  process text NOT NULL CHECK (process IN ('pesagem','misturador')),
  step integer NOT NULL,
  recipe text,
  started_at timestamptz NOT NULL,
  -- Null while the step is still running.
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS mortar_process_steps_device_time
  ON mortar_process_steps (device_id, process, started_at);

-- Applied by hand in the Supabase SQL editor: like every platform table, no RLS, no access from
-- the Data API roles, and the app role may read and write it.
DO $$
DECLARE role_name text;
BEGIN
  ALTER TABLE public.mortar_process_steps DISABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.mortar_process_steps FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mortar_process_steps FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.mortar_process_steps TO everlenz_iiot_app;
    GRANT USAGE ON SEQUENCE public.mortar_process_steps_id_seq TO everlenz_iiot_app;
  END IF;
END $$;
