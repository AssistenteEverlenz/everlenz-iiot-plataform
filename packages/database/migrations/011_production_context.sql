-- Attribute every telemetry sample and production rollup to a recipe/product.
-- A device may obtain the product from an HMI payload key or use a configured fallback.
CREATE TABLE production_context_settings (
 tenant_id uuid NOT NULL, device_id uuid PRIMARY KEY,
 product_key text, fallback_product_code text NOT NULL DEFAULT 'ITEM GERAL',
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id) ON DELETE CASCADE,
 CHECK(product_key IS NULL OR length(btrim(product_key)) BETWEEN 1 AND 120),
 CHECK(length(btrim(fallback_product_code)) BETWEEN 1 AND 120)
);

ALTER TABLE telemetry_samples
  ADD COLUMN product_code text NOT NULL DEFAULT 'ITEM GERAL';
CREATE INDEX samples_product_time
  ON telemetry_samples(device_id,product_code,timestamp DESC);

ALTER TABLE telemetry_hourly_rollups
  ADD COLUMN product_code text NOT NULL DEFAULT 'ITEM GERAL';
ALTER TABLE telemetry_hourly_rollups DROP CONSTRAINT telemetry_hourly_rollups_pkey;
ALTER TABLE telemetry_hourly_rollups
  ADD PRIMARY KEY(device_id,tag_id,product_code,bucket);
CREATE INDEX telemetry_rollups_product_bucket
  ON telemetry_hourly_rollups(device_id,product_code,bucket DESC);

CREATE OR REPLACE FUNCTION maintain_telemetry_hourly_rollup() RETURNS trigger
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
   tenant_id,site_id,device_id,tag_id,product_code,bucket,sample_count,value_sum,value_min,value_max,
   first_value,first_at,last_value,last_at,positive_delta
 ) VALUES(
   NEW.tenant_id,NEW.site_id,NEW.device_id,NEW.tag_id,NEW.product_code,hour_bucket,1,
   NEW.value_number,NEW.value_number,NEW.value_number,NEW.value_number,NEW.timestamp,
   NEW.value_number,NEW.timestamp,increment_value
 ) ON CONFLICT(device_id,tag_id,product_code,bucket) DO UPDATE SET
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

DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.production_context_settings FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.production_context_settings FROM PUBLIC;
