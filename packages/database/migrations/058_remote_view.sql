-- "Ver tela da IHM" (2026-11-21): the HMI's screen in the browser, through the plant's VPN.
--
-- Each machine's router (MikroTik hAP) keeps a WireGuard tunnel to the platform's server, and a
-- noVNC gateway (separate Coolify resource, ihm.everlenz.com.br) opens the HMI's VNC through it.
-- The platform only says where the HMI answers inside the tunnel and signs a short-lived link;
-- the address never comes from the browser.
CREATE TABLE IF NOT EXISTS device_remote_access (
  device_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  -- The HMI's address on the machine's LAN, reached through the tunnel (e.g. 192.168.77.50).
  hmi_ip text NOT NULL,
  hmi_port integer NOT NULL DEFAULT 5900 CHECK (hmi_port BETWEEN 1 AND 65535),
  enabled boolean NOT NULL DEFAULT true,
  -- The master always operates the screen; the plant's users only watch unless allowed here.
  customer_control boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);

-- Every link handed out: who opened which HMI, when, and how.
CREATE TABLE IF NOT EXISTS remote_view_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  user_id uuid,
  user_email text,
  mode text NOT NULL CHECK (mode IN ('view', 'control')),
  hmi_ip text NOT NULL,
  hmi_port integer NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS remote_view_sessions_device_created
  ON remote_view_sessions(device_id, created_at DESC);

-- Applied by hand in the Supabase SQL editor, where tables come out owned by postgres, exposed
-- to the Data API and with RLS on: give them to the platform like the others. The roles do not
-- exist in plain PostgreSQL/PGlite, hence the checks.
REVOKE ALL ON TABLE public.device_remote_access FROM PUBLIC;
REVOKE ALL ON TABLE public.remote_view_sessions FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.device_remote_access FROM %I', role_name);
   EXECUTE format('REVOKE ALL ON TABLE public.remote_view_sessions FROM %I', role_name);
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_remote_access TO everlenz_iiot_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.remote_view_sessions TO everlenz_iiot_app;
 END IF;
END $$;
ALTER TABLE public.device_remote_access DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_view_sessions DISABLE ROW LEVEL SECURITY;
