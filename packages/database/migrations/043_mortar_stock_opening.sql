-- The stock a mortar plant had of each product when it started counting on the platform. The
-- production history adds what was bagged since, so the stock curve starts from the real
-- balance; when invoices arrive (NF integration) they will take the sales out of it.
CREATE TABLE IF NOT EXISTS mortar_stock_opening (
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES mortar_products (id) ON DELETE CASCADE,
  bags double precision NOT NULL DEFAULT 0 CHECK (bags >= 0),
  as_of date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id)
);

-- Applied by hand in the Supabase SQL editor: same three corrections as every platform table.
ALTER TABLE public.mortar_stock_opening DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mortar_stock_opening FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mortar_stock_opening FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.mortar_stock_opening TO everlenz_iiot_app;
  END IF;
END $$;
