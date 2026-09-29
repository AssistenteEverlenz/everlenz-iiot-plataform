-- Every stop of the line, as it happens. The 5-minute buckets say how many seconds a machine
-- spent stopped, but never how many times it stopped, and that cannot be worked out afterwards
-- from seconds. Readings are pruned after three days, so a stop not recorded now is lost.
CREATE TABLE IF NOT EXISTS production_stops (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  -- Why the line was not producing: counter stopped, machine in manual, or gone quiet.
  state text NOT NULL CHECK (state IN ('idle', 'manual', 'offline')),
  started_at timestamptz NOT NULL,
  -- Open while the line is still stopped; closed when the counter moves again.
  ended_at timestamptz,
  seconds double precision,
  -- A scheduled break is not a failure: counted apart.
  during_pause boolean NOT NULL DEFAULT false,
  product_code text,
  production_date date,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);

-- One stop per device per instant, and only one open at a time.
CREATE UNIQUE INDEX IF NOT EXISTS production_stops_start_unique
  ON production_stops (device_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS production_stops_open_unique
  ON production_stops (device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS production_stops_by_day
  ON production_stops (tenant_id, device_id, production_date);
