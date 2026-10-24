-- Manual additives of the mortar recipes (2026-10-24).
--
-- Some of a batch never crosses the scale: the operator pours the additive (cellulose ether,
-- redispersible polymer, air entrainer, pigment...) straight into the mixer while it waits for
-- it. That mass is in every bag but not in the scale's figure, so the mixed tons came out short
-- and the bags looked light; its price was missing from the cost of the batch. A plant keeps a
-- catalog of its additives (price per kg, the bag they come in) and says how much of each goes
-- into one batch of each mixer recipe; the platform adds it to the batch's mass and cost.
CREATE TABLE IF NOT EXISTS mortar_additives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  kind text NOT NULL DEFAULT 'outro'
    CHECK (kind IN ('celulose','polimero','incorporador','retardador','hidrofugante','pigmento','fibra','outro')),
  price_per_kg double precision CHECK (price_per_kg IS NULL OR price_per_kg >= 0),
  -- The package it comes in (a 20 kg bag), so a dose reads as "2 sacos" at the mixer.
  package_kg double precision CHECK (package_kg IS NULL OR package_kg > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- How much of each additive goes into ONE batch of a mixer recipe (the name the HMI sends).
CREATE TABLE IF NOT EXISTS mortar_recipe_additives (
  tenant_id uuid NOT NULL,
  recipe text NOT NULL,
  additive_id uuid NOT NULL REFERENCES mortar_additives (id) ON DELETE CASCADE,
  kg_per_batch double precision NOT NULL CHECK (kg_per_batch > 0 AND kg_per_batch <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, recipe, additive_id)
);

-- The card where recipes and additives are set up.
ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal','shift_board','stops','wear',
    'bagging','mortar_output','mortar_materials','mortar_yield','mortar_mixer','mortar_recipes'
  ));

-- Applied by hand in the Supabase SQL editor: same three corrections as every platform table.
ALTER TABLE public.mortar_additives DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortar_recipe_additives DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mortar_additives, public.mortar_recipe_additives FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.mortar_additives, public.mortar_recipe_additives FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.mortar_additives, public.mortar_recipe_additives TO everlenz_iiot_app;
  END IF;
END $$;
