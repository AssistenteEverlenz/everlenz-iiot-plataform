-- Shift history made editable, without letting the automatic close undo a person's choice.
--  * source: 'auto' rows are written by the shift close; 'manual' rows are partial snapshots
--    someone generated ("Gerar parcial agora"). Only automatic rows are unique per shift, so
--    a snapshot never blocks the real close and several snapshots can coexist.
--  * deleted_at: removing a row hides it. The close still sees it, so a deleted automatic row
--    is not written again; "Recalcular período" is the explicit way to rebuild rows.
--  * weight_tag_id: the weight per piece can come from an HMI variable (recipe weight); the
--    fixed weight_per_unit_kg stays as the fallback.
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'auto'
  CHECK(source IN ('auto','manual'));
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_device_id_kind_planned_start_key;
CREATE UNIQUE INDEX IF NOT EXISTS shift_reports_auto_unique
  ON shift_reports(device_id,kind,planned_start) WHERE source='auto';

ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS weight_tag_id uuid;
DO $$ BEGIN
  ALTER TABLE production_settings ADD CONSTRAINT production_settings_weight_tag_fk
    FOREIGN KEY(tenant_id,device_id,weight_tag_id) REFERENCES tags(tenant_id,device_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
