-- Manual snapshots of a dashboard: a "photo" of the page (its cards and their settings, and the
-- device's production parameters) taken from the Ações menu and restorable from there. Anyone
-- who can open the dashboard may take and restore them; a restore first snapshots the current
-- state, so it can always be undone.
CREATE TABLE IF NOT EXISTS dashboard_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 dashboard_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
 content jsonb NOT NULL,
 created_by uuid,
 created_by_email text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,dashboard_id) REFERENCES dashboards(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS dashboard_snapshots_dashboard
  ON dashboard_snapshots(dashboard_id,created_at DESC);

-- The default model new devices start from: the cards of a chosen dashboard, without variables.
CREATE TABLE IF NOT EXISTS dashboard_templates (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 source_dashboard_id uuid,
 content jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.dashboard_snapshots, public.dashboard_templates FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.dashboard_snapshots, public.dashboard_templates FROM PUBLIC;
