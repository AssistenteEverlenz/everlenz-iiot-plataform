-- The target per shift can come from an HMI variable (it depends on the product or recipe the
-- machine is running); the fixed target_per_shift stays as the fallback. Each closed shift keeps
-- the target it had when it closed, in shift_reports.target_value.
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS target_tag_id uuid;
DO $$ BEGIN
  ALTER TABLE production_settings ADD CONSTRAINT production_settings_target_tag_fk
    FOREIGN KEY(tenant_id,device_id,target_tag_id) REFERENCES tags(tenant_id,device_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
