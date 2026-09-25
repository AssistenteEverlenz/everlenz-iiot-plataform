ALTER TABLE devices ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_latitude_check;
ALTER TABLE devices ADD CONSTRAINT devices_latitude_check CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_longitude_check;
ALTER TABLE devices ADD CONSTRAINT devices_longitude_check CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_coordinates_pair_check;
ALTER TABLE devices ADD CONSTRAINT devices_coordinates_pair_check CHECK ((latitude IS NULL) = (longitude IS NULL));

UPDATE devices d
SET address = s.address,
    city = s.city,
    state = s.state,
    latitude = s.latitude,
    longitude = s.longitude,
    location_updated_at = s.location_updated_at
FROM sites s
WHERE s.id = d.site_id AND s.tenant_id = d.tenant_id
  AND d.address IS NULL AND d.city IS NULL AND d.state IS NULL
  AND d.latitude IS NULL AND d.longitude IS NULL;

CREATE INDEX IF NOT EXISTS devices_location_idx
  ON devices(tenant_id, state, city)
  WHERE archived_at IS NULL;
