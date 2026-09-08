-- Keep existing schema/data and defer RLS. Deny browser/PostgREST roles on IIoT objects only.
-- Roles do not exist in plain PostgreSQL/PGlite, hence conditional role handling.
REVOKE ALL ON TABLE public.tenants, public.sites, public.devices, public.tags,
 public.device_topic_mappings, public.mqtt_messages_raw, public.telemetry_samples,
 public.device_status, public.schema_migrations FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.mqtt_messages_raw_id_seq, public.telemetry_samples_id_seq FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.tenants, public.sites, public.devices, public.tags, public.device_topic_mappings, public.mqtt_messages_raw, public.telemetry_samples, public.device_status, public.schema_migrations FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON SEQUENCE public.mqtt_messages_raw_id_seq, public.telemetry_samples_id_seq FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
