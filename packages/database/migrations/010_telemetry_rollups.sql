-- Incremental numeric rollups keep managerial history independent from raw sample volume.
CREATE TABLE telemetry_numeric_state (
 tenant_id uuid NOT NULL, site_id uuid NOT NULL, device_id uuid NOT NULL, tag_id uuid NOT NULL,
 last_timestamp timestamptz NOT NULL, last_value double precision NOT NULL,
 PRIMARY KEY(device_id,tag_id),
 FOREIGN KEY(tenant_id,device_id,tag_id) REFERENCES tags(tenant_id,device_id,id) ON DELETE CASCADE
);

CREATE TABLE telemetry_hourly_rollups (
 tenant_id uuid NOT NULL, site_id uuid NOT NULL, device_id uuid NOT NULL, tag_id uuid NOT NULL,
 bucket timestamptz NOT NULL, sample_count bigint NOT NULL,
 value_sum double precision NOT NULL, value_min double precision NOT NULL,
 value_max double precision NOT NULL, first_value double precision NOT NULL,
 first_at timestamptz NOT NULL, last_value double precision NOT NULL,
 last_at timestamptz NOT NULL, positive_delta double precision NOT NULL DEFAULT 0,
 PRIMARY KEY(device_id,tag_id,bucket),
 FOREIGN KEY(tenant_id,device_id,tag_id) REFERENCES tags(tenant_id,device_id,id) ON DELETE CASCADE
);
CREATE INDEX telemetry_rollups_tenant_bucket
  ON telemetry_hourly_rollups(tenant_id,bucket DESC);

-- Establish the initial history before enabling incremental maintenance.
WITH ordered AS (
 SELECT tenant_id,site_id,device_id,tag_id,timestamp,value_number,
   lag(value_number) OVER (PARTITION BY device_id,tag_id ORDER BY timestamp,id) previous_value
 FROM telemetry_samples WHERE value_number IS NOT NULL
), grouped AS (
 SELECT tenant_id,site_id,device_id,tag_id,date_trunc('hour',timestamp) bucket,
   count(*) sample_count,sum(value_number) value_sum,min(value_number) value_min,
   max(value_number) value_max,
   (array_agg(value_number ORDER BY timestamp))[1] first_value,min(timestamp) first_at,
   (array_agg(value_number ORDER BY timestamp DESC))[1] last_value,max(timestamp) last_at,
   sum(CASE WHEN previous_value IS NULL THEN 0
     WHEN value_number >= previous_value THEN value_number-previous_value
     ELSE greatest(value_number,0) END) positive_delta
 FROM ordered
 GROUP BY tenant_id,site_id,device_id,tag_id,date_trunc('hour',timestamp)
)
INSERT INTO telemetry_hourly_rollups(
 tenant_id,site_id,device_id,tag_id,bucket,sample_count,value_sum,value_min,value_max,
 first_value,first_at,last_value,last_at,positive_delta
)
SELECT tenant_id,site_id,device_id,tag_id,bucket,sample_count,value_sum,value_min,value_max,
 first_value,first_at,last_value,last_at,positive_delta FROM grouped;

INSERT INTO telemetry_numeric_state(
 tenant_id,site_id,device_id,tag_id,last_timestamp,last_value
)
SELECT DISTINCT ON (device_id,tag_id)
 tenant_id,site_id,device_id,tag_id,timestamp,value_number
FROM telemetry_samples WHERE value_number IS NOT NULL
ORDER BY device_id,tag_id,timestamp DESC,id DESC;

CREATE FUNCTION maintain_telemetry_hourly_rollup() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
 prior telemetry_numeric_state%ROWTYPE;
 increment_value double precision := 0;
 hour_bucket timestamptz := date_trunc('hour',NEW.timestamp);
BEGIN
 IF NEW.value_number IS NULL THEN RETURN NEW; END IF;

 SELECT * INTO prior FROM telemetry_numeric_state
 WHERE device_id=NEW.device_id AND tag_id=NEW.tag_id FOR UPDATE;

 IF NOT FOUND THEN
   INSERT INTO telemetry_numeric_state(
     tenant_id,site_id,device_id,tag_id,last_timestamp,last_value
   ) VALUES(NEW.tenant_id,NEW.site_id,NEW.device_id,NEW.tag_id,NEW.timestamp,NEW.value_number);
 ELSIF NEW.timestamp > prior.last_timestamp THEN
   increment_value := CASE WHEN NEW.value_number >= prior.last_value
     THEN NEW.value_number-prior.last_value ELSE greatest(NEW.value_number,0) END;
   UPDATE telemetry_numeric_state SET tenant_id=NEW.tenant_id,site_id=NEW.site_id,
     last_timestamp=NEW.timestamp,last_value=NEW.value_number
   WHERE device_id=NEW.device_id AND tag_id=NEW.tag_id;
 END IF;

 INSERT INTO telemetry_hourly_rollups(
   tenant_id,site_id,device_id,tag_id,bucket,sample_count,value_sum,value_min,value_max,
   first_value,first_at,last_value,last_at,positive_delta
 ) VALUES(
   NEW.tenant_id,NEW.site_id,NEW.device_id,NEW.tag_id,hour_bucket,1,
   NEW.value_number,NEW.value_number,NEW.value_number,NEW.value_number,NEW.timestamp,
   NEW.value_number,NEW.timestamp,increment_value
 ) ON CONFLICT(device_id,tag_id,bucket) DO UPDATE SET
   sample_count=telemetry_hourly_rollups.sample_count+1,
   value_sum=telemetry_hourly_rollups.value_sum+EXCLUDED.value_sum,
   value_min=least(telemetry_hourly_rollups.value_min,EXCLUDED.value_min),
   value_max=greatest(telemetry_hourly_rollups.value_max,EXCLUDED.value_max),
   first_value=CASE WHEN EXCLUDED.first_at < telemetry_hourly_rollups.first_at
     THEN EXCLUDED.first_value ELSE telemetry_hourly_rollups.first_value END,
   first_at=least(telemetry_hourly_rollups.first_at,EXCLUDED.first_at),
   last_value=CASE WHEN EXCLUDED.last_at > telemetry_hourly_rollups.last_at
     THEN EXCLUDED.last_value ELSE telemetry_hourly_rollups.last_value END,
   last_at=greatest(telemetry_hourly_rollups.last_at,EXCLUDED.last_at),
   positive_delta=telemetry_hourly_rollups.positive_delta+EXCLUDED.positive_delta;
 RETURN NEW;
END $$;

CREATE TRIGGER telemetry_hourly_rollup_after_insert
AFTER INSERT ON telemetry_samples FOR EACH ROW EXECUTE FUNCTION maintain_telemetry_hourly_rollup();

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.telemetry_numeric_state, public.telemetry_hourly_rollups FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.telemetry_numeric_state, public.telemetry_hourly_rollups FROM PUBLIC;

