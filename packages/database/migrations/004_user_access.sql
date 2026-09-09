-- Application authentication, per-device authorization and tenant branding.
CREATE TABLE app_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 email text NOT NULL,
 full_name text NOT NULL,
 role text NOT NULL DEFAULT 'user' CHECK(role IN ('master','user')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 password_hash text NOT NULL,
 must_change_password boolean NOT NULL DEFAULT true,
 last_login_at timestamptz,
 created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX app_users_email_unique ON app_users(lower(email));
CREATE INDEX app_users_tenant_status ON app_users(tenant_id,status,full_name);

CREATE TABLE user_device_access (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 device_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,device_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES app_users(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX user_device_access_device ON user_device_access(device_id,user_id);

CREATE TABLE app_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 ip_address text,
 user_agent text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_sessions_user_expiry ON app_sessions(user_id,expires_at DESC);
CREATE INDEX app_sessions_expiry ON app_sessions(expires_at);

CREATE TABLE tenant_branding (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 product_name text NOT NULL DEFAULT 'Everlenz IIoT',
 subtitle text NOT NULL DEFAULT 'Industrial Intelligence',
 logo_url text,
 primary_color text NOT NULL DEFAULT '#0b2028' CHECK(primary_color ~ '^#[0-9A-Fa-f]{6}$'),
 accent_color text NOT NULL DEFAULT '#12b8a6' CHECK(accent_color ~ '^#[0-9A-Fa-f]{6}$'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenant_branding(tenant_id)
SELECT id FROM tenants
ON CONFLICT(tenant_id) DO NOTHING;

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.app_users, public.user_device_access, public.app_sessions, public.tenant_branding FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.app_users, public.user_device_access, public.app_sessions, public.tenant_branding FROM PUBLIC;
