-- Security hardening: stop storing device broker passwords, record who changed what,
-- and make login lockout survive a restart. See SECURITY.md items 12, 16 and 7b.

-- Item 12. The device MQTT password was stored in clear text and returned by the API on
-- every read, so one compromised master account or database dump exposed the broker
-- credential of every equipment, permanently. The secret is now shown once at creation
-- or rotation and never persisted; only the moment of the last rotation is kept.
-- Existing plaintext secrets are destroyed by this drop: those devices must be rotated.
ALTER TABLE devices DROP COLUMN IF EXISTS mqtt_password;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_credential_rotated_at timestamptz;
UPDATE devices SET mqtt_credential_rotated_at = created_at
WHERE mqtt_credential_rotated_at IS NULL AND mqtt_username IS NOT NULL;

-- Item 16. Without this there is no way to answer "who did this" after an incident.
-- Append-only by convention; no UPDATE or DELETE path exists in the application.
CREATE TABLE IF NOT EXISTS audit_log (
 id bigserial PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
 actor_email text NOT NULL,
 actor_role text NOT NULL CHECK(actor_role IN ('master','user')),
 action text NOT NULL,
 target_type text NOT NULL,
 target_id text,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 ip_address text,
 user_agent text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_created ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_created ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target ON audit_log(target_type, target_id, created_at DESC);

-- Item 7b. The in-process attempt map resets on redeploy and is not shared between API
-- replicas. These columns make the lockout durable. The in-memory throttle stays as a
-- cheap first layer: it also covers e-mails that have no row here at all.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.audit_log FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON SEQUENCE public.audit_log_id_seq FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.audit_log FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.audit_log_id_seq FROM PUBLIC;
