-- Housekeeping from the 2026-10-28 database review (Supabase advisors).
--
-- Seven indexes no query used in a month of production. tags/sites/devices_tenant and
-- sites_with_coordinates are covered by unique indexes that start with tenant_id; raw_status by
-- raw_pending_received. audit_log_tenant_created serves no screen (nothing reads the log by
-- tenant), and tv_screens holds a handful of rows, so a scan costs nothing.
-- raw_pending_received stays on purpose: the ingestor recreates it on every start and the app
-- role may not create indexes, so dropping it would stop ingestion at the next restart.
DROP INDEX IF EXISTS tags_tenant;
DROP INDEX IF EXISTS sites_tenant;
DROP INDEX IF EXISTS devices_tenant;
DROP INDEX IF EXISTS raw_status;
DROP INDEX IF EXISTS audit_log_tenant_created;
DROP INDEX IF EXISTS tv_screens_dashboard;
DROP INDEX IF EXISTS sites_with_coordinates;

-- purge_device ran with the caller's search_path: pin it so a schema earlier in the path cannot
-- stand in for the tables it deletes from.
ALTER FUNCTION purge_device(uuid, uuid) SET search_path = public, pg_temp;
