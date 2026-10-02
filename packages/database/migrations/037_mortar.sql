-- Dry mortar (argamassa) plants: a mixing line that doses sand, cement and a complement by recipe
-- in batches, and a bagging machine whose spouts (bicos) each fill bags on a recipe of their own.
--
-- Nothing here touches the ceramic tables: a mortar plant has its own settings, buckets and
-- batches, and the ceramic boards keep reading production_buckets exactly as before.
--
--  * A site says which industry it is, so the screens offer the cards that fit it.
--  * One device may carry both parts (the mixing HMI also reads the bagging PLC), so mixing and
--    bagging are modules of a device rather than kinds of device.
--  * The same commercial product is often saved as one recipe per spout ("AC-II 20kg LE",
--    "AC-II 20kg CT"), so recipes are linked to products, and the product holds the bag weight.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS segment text NOT NULL DEFAULT 'ceramica'
  CHECK (segment IN ('ceramica','argamassa'));

-- Which variables drive each module. materials: [{"label":"Areia","tagId":"<uuid>"}], where the
-- tag is the recipe's desired weight for that material in one batch.
CREATE TABLE IF NOT EXISTS mortar_settings (
  device_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  mix_enabled boolean NOT NULL DEFAULT false,
  recipe_tag_id uuid,
  batch_count_tag_id uuid,
  scale_tag_id uuid,
  materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  bagging_enabled boolean NOT NULL DEFAULT false,
  idle_seconds integer NOT NULL DEFAULT 120 CHECK (idle_seconds BETWEEN 10 AND 3600),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bagging_spouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 24),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  count_tag_id uuid,
  recipe_tag_id uuid,
  running_tag_id uuid,
  enabled_tag_id uuid,
  UNIQUE (device_id, position),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id) ON DELETE CASCADE
);

-- 5-minute buckets per spout and recipe, written by the ingestor as messages arrive.
CREATE TABLE IF NOT EXISTS bagging_buckets (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  spout_id uuid NOT NULL REFERENCES bagging_spouts (id) ON DELETE CASCADE,
  bucket timestamptz NOT NULL,
  recipe text NOT NULL,
  bags double precision NOT NULL DEFAULT 0,
  running_s double precision NOT NULL DEFAULT 0,
  idle_s double precision NOT NULL DEFAULT 0,
  off_s double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (spout_id, bucket, recipe)
);
CREATE INDEX IF NOT EXISTS bagging_buckets_device_time ON bagging_buckets (device_id, bucket);

-- Where the ingestor left each spout, so a restart never counts a bag twice.
CREATE TABLE IF NOT EXISTS bagging_runtime (
  spout_id uuid PRIMARY KEY REFERENCES bagging_spouts (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  last_at timestamptz NOT NULL,
  last_count double precision,
  last_increment_at timestamptz,
  enabled boolean,
  running boolean,
  recipe text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row each time the batch counter moves. materials: [{"label":"Areia","kg":500}], the
-- recipe's weights times the batches; scale_kg is the heaviest reading of the scale in the
-- cycle, the real dosed total, when a scale variable is configured.
CREATE TABLE IF NOT EXISTS mix_batches (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  finished_at timestamptz NOT NULL,
  recipe text NOT NULL,
  batches integer NOT NULL DEFAULT 1 CHECK (batches > 0),
  materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_kg double precision NOT NULL DEFAULT 0,
  scale_kg double precision,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mix_batches_device_time ON mix_batches (device_id, finished_at);

CREATE TABLE IF NOT EXISTS mix_runtime (
  device_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  last_at timestamptz NOT NULL,
  last_count double precision,
  scale_peak double precision,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id) ON DELETE CASCADE
);

-- What the owner sells. The bag weight lives here, not in the spout recipe: the recipe's desired
-- weight is a cut point the operator tunes (19,80 or 20,20) and must not become the accounting.
CREATE TABLE IF NOT EXISTS mortar_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  nominal_kg double precision NOT NULL CHECK (nominal_kg > 0 AND nominal_kg <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Which product each recipe name fills. Per tenant, since the name is what the HMI sends.
CREATE TABLE IF NOT EXISTS mortar_recipe_links (
  tenant_id uuid NOT NULL,
  recipe text NOT NULL,
  product_id uuid NOT NULL REFERENCES mortar_products (id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, recipe)
);

ALTER TABLE dashboard_widgets DROP CONSTRAINT dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal','shift_board','stops','wear',
    'bagging','mortar_output','mortar_materials','mortar_yield'
  ));

-- Applied by hand in the Supabase SQL editor: tables come out owned by postgres, exposed to its
-- Data API and with RLS on. Undo all three, like every other platform table.
DO $$
DECLARE
  role_name text;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['mortar_settings','bagging_spouts','bagging_buckets',
    'bagging_runtime','mix_batches','mix_runtime','mortar_products','mortar_recipe_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO everlenz_iiot_app', table_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
    GRANT USAGE ON SEQUENCE public.mix_batches_id_seq TO everlenz_iiot_app;
  END IF;
END $$;
