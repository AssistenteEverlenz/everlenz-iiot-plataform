-- Who is connected with each device's credential (2026-10-30), read from the broker's own log.
--
-- A restored backup of an HMI carries the real credential and published on Cerâmica Oliveira's
-- topic three times. The broker logs every connection with its client id and address, so the
-- platform can tell the HMIs apart without touching any of them. This first stage only records
-- and warns the platform's master; nothing is refused or dropped.
CREATE TABLE IF NOT EXISTS device_connections (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  client_id text NOT NULL,
  ip text,
  connected_at timestamptz NOT NULL,
  disconnected_at timestamptz,
  -- 'closed', 'disconnected', 'timeout', 'replaced' (another connection took the client id).
  end_reason text,
  -- A client id this device had never used before, after it already had a history.
  new_client boolean NOT NULL DEFAULT false,
  -- Another connection of the same device was open when this one came in.
  overlapped boolean NOT NULL DEFAULT false,
  dismissed_at timestamptz,
  UNIQUE (device_id, client_id, connected_at),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_connections_device_connected
  ON device_connections(device_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS device_connections_open
  ON device_connections(client_id) WHERE disconnected_at IS NULL;

-- Applied by hand in the Supabase SQL editor, where the table comes out owned by postgres,
-- exposed to the Data API and with RLS on: give it to the platform like the others. The roles
-- do not exist in plain PostgreSQL/PGlite, hence the checks.
REVOKE ALL ON TABLE public.device_connections FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.device_connections FROM %I', role_name);
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_connections TO everlenz_iiot_app;
  GRANT USAGE, SELECT ON SEQUENCE public.device_connections_id_seq TO everlenz_iiot_app;
 END IF;
END $$;
ALTER TABLE public.device_connections DISABLE ROW LEVEL SECURITY;
