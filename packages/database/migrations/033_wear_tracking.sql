-- Wear of the line, which the telemetry cannot see on its own.
--
-- The tonnage the platform computes is pieces times the recipe's nominal weight, so it says
-- nothing about the mass of a real brick: only a person weighing bricks can show that the die
-- (boquilha) is opening. The measured weight is a separate series and never overwrites
-- production_settings.weight_per_unit_kg, or the tonnage of every past shift would change.
CREATE TABLE IF NOT EXISTS weight_measurements (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  production_date date NOT NULL,
  -- Wear is read per recipe: the same die gives a different weight for a different brick.
  product_code text NOT NULL,
  -- What the machine was actually running when the sample was taken, when it is known. If it
  -- differs from product_code the sample can be set aside later.
  running_product_code text,
  -- Every brick of the sample, in kilograms. The spread between them often shows a worn die
  -- before the average moves.
  grams jsonb NOT NULL,
  pieces smallint NOT NULL CHECK (pieces > 0),
  average_kg double precision NOT NULL CHECK (average_kg > 0),
  spread_kg double precision,
  -- The recipe's nominal weight at the time, so the drift can be read back years later even if
  -- the recipe is changed.
  nominal_kg double precision,
  note text,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A correction never erases: it points at what it replaces.
  replaces_id bigint REFERENCES weight_measurements(id),
  voided_at timestamptz,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS weight_measurements_by_day
  ON weight_measurements (tenant_id, device_id, production_date);

-- When a worn part was replaced: every wear curve is read from the last change, not from the
-- beginning of time. Galo changed its auger between 18 and 21 September 2026 and the line's
-- capability rose by half, which is what a recovery looks like.
CREATE TABLE IF NOT EXISTS maintenance_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  happened_on date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('boquilha', 'caracol', 'outro')),
  note text,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS maintenance_events_by_device
  ON maintenance_events (tenant_id, device_id, happened_on DESC);

-- Who may write a measurement. A typed name cannot be checked and invites both typos and
-- mischief, so the author is always the logged-in user, and only users given this may write.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS can_log_measurements boolean NOT NULL DEFAULT false;
