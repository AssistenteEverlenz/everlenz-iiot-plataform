-- Deleting a device removes it and everything recorded for it; only the audit log keeps who
-- deleted it and when. Several tables reference devices (or their tags and raw messages)
-- without ON DELETE CASCADE, so one function deletes in dependency order; the API calls it.
-- Devices "deleted" before this migration were only archived. They are not purged here: that
-- irreversible cleanup of existing data is a separate, explicitly confirmed operation.
CREATE OR REPLACE FUNCTION purge_device(p_tenant uuid, p_device uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Samples reference tags and raw messages; raw messages and status reference the device.
  DELETE FROM telemetry_samples WHERE tenant_id=p_tenant AND device_id=p_device;
  DELETE FROM mqtt_messages_raw WHERE tenant_id=p_tenant AND device_id=p_device;
  DELETE FROM device_status WHERE tenant_id=p_tenant AND device_id=p_device;
  -- Production settings reference tags without cascade: they go before the tags.
  DELETE FROM production_settings WHERE tenant_id=p_tenant AND device_id=p_device;
  -- Cascades to dashboard widgets and personal dashboard configurations.
  DELETE FROM dashboards WHERE tenant_id=p_tenant AND device_id=p_device;
  -- Cascades to hourly rollups and numeric state.
  DELETE FROM tags WHERE tenant_id=p_tenant AND device_id=p_device;
  DELETE FROM device_topic_mappings WHERE tenant_id=p_tenant AND device_id=p_device;
  -- Cascades to the signal catalog, user access, production context and hidden products.
  DELETE FROM devices WHERE tenant_id=p_tenant AND id=p_device;
END
$$;
