-- Plain-MQTT compatibility for HMIs whose TLS client cannot reach the broker (Delta DOP-100
-- firmware). TLS stays the default for every device. A device switched to legacy mode may
-- connect on the compatibility port only from the public addresses released for it; attempts
-- from any other address are kept here so the device page can offer to release them.
-- Releasing an address is always a person's decision: a device that stops communicating after
-- its plant changes public IP is checked by someone before the new address is trusted.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS legacy_plain_mqtt boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS legacy_allowed_ips text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS device_legacy_attempts (
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, source_ip text NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 attempts bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(device_id, source_ip),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE
);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.device_legacy_attempts FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.device_legacy_attempts FROM PUBLIC;
