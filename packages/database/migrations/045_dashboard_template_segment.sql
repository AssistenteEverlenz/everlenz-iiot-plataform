-- One panel model per segment.
--
-- The model new devices start from was one per tenant, so a mortar plant registered after a
-- ceramic model was saved got the ceramic cards (pallets, kiln, wear). Each segment now keeps
-- its own: "Usar este painel como modelo" saves under the segment of the panel's plant, and a
-- new device takes the model of its plant's segment. The model saved so far is the ceramic one.
ALTER TABLE dashboard_templates
  ADD COLUMN IF NOT EXISTS segment text NOT NULL DEFAULT 'ceramica'
  CHECK (segment IN ('ceramica','argamassa'));

ALTER TABLE dashboard_templates DROP CONSTRAINT IF EXISTS dashboard_templates_pkey;
ALTER TABLE dashboard_templates ADD PRIMARY KEY (tenant_id, segment);
