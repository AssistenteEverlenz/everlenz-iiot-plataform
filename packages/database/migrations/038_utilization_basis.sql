-- How the board's "Aproveitamento da máquina" is counted, per equipment. 'idle' (the default)
-- is producing ÷ (producing + idle): a machine with automation that stops itself. 'stopped' also
-- counts manual stops against it, for a machine without automation that is either producing or
-- stopped and is never idle on its own.
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS utilization_basis text;
DO $$ BEGIN
  ALTER TABLE production_settings ADD CONSTRAINT production_settings_utilization_basis_check
    CHECK (utilization_basis IS NULL OR utilization_basis IN ('idle','stopped'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
