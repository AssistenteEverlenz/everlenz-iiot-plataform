-- Geographic position belongs to the plant, not to an HMI. Keeping the resolved coordinates
-- avoids geocoding on every map view and lets one site contain several production devices.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

DO $$ BEGIN
  ALTER TABLE sites ADD CONSTRAINT sites_latitude_range CHECK(latitude IS NULL OR latitude BETWEEN -90 AND 90);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sites ADD CONSTRAINT sites_longitude_range CHECK(longitude IS NULL OR longitude BETWEEN -180 AND 180);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sites ADD CONSTRAINT sites_coordinates_pair CHECK((latitude IS NULL) = (longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS sites_with_coordinates ON sites(tenant_id,name) WHERE latitude IS NOT NULL;
