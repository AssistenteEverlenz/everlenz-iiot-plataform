-- Configurable TV per dashboard: screens shown in turn, each a 12-column grid of cards placed
-- by the master. A card is either a dashboard card (widget_id) or a TV block (shift numbers,
-- S-curve, today's product mix, week targets, machine state, stop alert). Without screens the
-- TV shows its default pages. The whole set is replaced at once when the master saves.
CREATE TABLE IF NOT EXISTS tv_screens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 dashboard_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
 position integer NOT NULL DEFAULT 0,
 duration_seconds integer NOT NULL DEFAULT 20 CHECK(duration_seconds BETWEEN 5 AND 600),
 grid_rows integer NOT NULL DEFAULT 12 CHECK(grid_rows BETWEEN 4 AND 24),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,dashboard_id) REFERENCES dashboards(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS tv_screens_dashboard ON tv_screens(dashboard_id,position);

CREATE TABLE IF NOT EXISTS tv_cards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 screen_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('widget','tv_kpis','tv_curve','tv_daymix','tv_week','tv_state','tv_alert')),
 widget_id uuid REFERENCES dashboard_widgets(id) ON DELETE CASCADE,
 x integer NOT NULL CHECK(x BETWEEN 1 AND 12),
 y integer NOT NULL CHECK(y BETWEEN 1 AND 24),
 w integer NOT NULL CHECK(w BETWEEN 1 AND 12),
 h integer NOT NULL CHECK(h BETWEEN 1 AND 24),
 config jsonb NOT NULL DEFAULT '{}'::jsonb,
 position integer NOT NULL DEFAULT 0,
 FOREIGN KEY(tenant_id,screen_id) REFERENCES tv_screens(tenant_id,id) ON DELETE CASCADE,
 CHECK(kind <> 'widget' OR widget_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tv_cards_screen ON tv_cards(screen_id,position);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.tv_screens, public.tv_cards FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.tv_screens, public.tv_cards FROM PUBLIC;
