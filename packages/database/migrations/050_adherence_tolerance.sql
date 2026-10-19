-- A tolerance for the shift as it happened (2026-10-19).
--
-- The board's "Turno previsto × real" compares the real start, pauses and end with the registered
-- times. A difference within this many minutes (either way) is on time: shown, but not counted as
-- time lost or gained. Past it, the whole difference counts. 0 counts every minute, as before.
-- Set per machine from the pencil of the "Aproveitamento da máquina" card.
ALTER TABLE production_settings
  ADD COLUMN IF NOT EXISTS adherence_tolerance_minutes integer NOT NULL DEFAULT 0
  CHECK (adherence_tolerance_minutes BETWEEN 0 AND 120);
