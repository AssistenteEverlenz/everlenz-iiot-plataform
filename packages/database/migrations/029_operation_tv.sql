-- TV of the operations page: screens shown in turn, each a 12-column grid of plants, so a group
-- watches every ceramic at once on a wall display without scrolling. Same shape as the
-- dashboard's TV (migration 023), but a card is a device and the set belongs to the tenant.
-- Without screens the TV fits every plant it can see on as few screens as possible.
CREATE TABLE IF NOT EXISTS operation_tv_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0,
  duration_seconds integer NOT NULL DEFAULT 20 CHECK (duration_seconds BETWEEN 5 AND 600),
  grid_rows integer NOT NULL DEFAULT 12 CHECK (grid_rows BETWEEN 4 AND 24),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS operation_tv_screens_tenant ON operation_tv_screens(tenant_id, position);

CREATE TABLE IF NOT EXISTS operation_tv_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  screen_id uuid NOT NULL,
  device_id uuid NOT NULL,
  x integer NOT NULL CHECK (x BETWEEN 1 AND 12),
  y integer NOT NULL CHECK (y BETWEEN 1 AND 24),
  w integer NOT NULL CHECK (w BETWEEN 1 AND 12),
  h integer NOT NULL CHECK (h BETWEEN 1 AND 24),
  position integer NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, screen_id) REFERENCES operation_tv_screens(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS operation_tv_cards_screen ON operation_tv_cards(screen_id, position);

-- Created by hand in the Supabase SQL editor, these come out owned by postgres, granted to the
-- public API roles and with row security on: the platform's role would be refused every write.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.operation_tv_screens, public.operation_tv_cards FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') AND current_user <> 'everlenz_iiot_app' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operation_tv_screens, public.operation_tv_cards TO everlenz_iiot_app;
  END IF;
END $$;
REVOKE ALL ON TABLE public.operation_tv_screens, public.operation_tv_cards FROM PUBLIC;
ALTER TABLE public.operation_tv_screens DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_tv_cards DISABLE ROW LEVEL SECURITY;
