-- Products a master chose to hide on a device: test recipes, discontinued items.
-- Hiding is reversible and destroys nothing: telemetry stays intact, the product is only
-- left out of totals, charts and rankings, and restoring brings its full history back.
CREATE TABLE hidden_products (
 tenant_id uuid NOT NULL,
 device_id uuid NOT NULL,
 product_code text NOT NULL,
 hidden_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
 hidden_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(device_id, product_code),
 FOREIGN KEY(tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.hidden_products FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.hidden_products FROM PUBLIC;
