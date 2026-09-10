-- Production roles: which configured tag plays which managerial part on each device.
-- production_settings (migration 003) already carried rate, run status and OEE inputs but
-- was never wired. This adds the counters the managerial board needs.
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS pallets_tag_id uuid;
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS blocks_tag_id uuid;
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS tons_total_tag_id uuid;
ALTER TABLE production_settings
  ADD CONSTRAINT production_settings_pallets_tag_fk
  FOREIGN KEY(tenant_id,device_id,pallets_tag_id) REFERENCES tags(tenant_id,device_id,id);
ALTER TABLE production_settings
  ADD CONSTRAINT production_settings_blocks_tag_fk
  FOREIGN KEY(tenant_id,device_id,blocks_tag_id) REFERENCES tags(tenant_id,device_id,id);
ALTER TABLE production_settings
  ADD CONSTRAINT production_settings_tons_total_tag_fk
  FOREIGN KEY(tenant_id,device_id,tons_total_tag_id) REFERENCES tags(tenant_id,device_id,id);
