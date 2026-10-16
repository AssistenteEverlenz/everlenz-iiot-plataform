-- The mixer of a mortar plant, configured instead of assumed (2026-10-16).
--
-- The mixer board read its variables by fixed names (ProcessoPesagem, TempoMistura...) and the
-- steps of Bella Massa's PLC were written in the code. Another PLC names and numbers them its own
-- way, so each device now keeps its own: which variable plays each role, the steps of the
-- weighing and of the mixer (number, name, kind, the material it doses, the timed step it is),
-- and the codes of its alert word. Null keeps the names of the first plant, so nothing changes
-- for a device until someone configures it.
ALTER TABLE mortar_settings ADD COLUMN IF NOT EXISTS mixer_config jsonb;

-- The alert word is kept like the steps: a row when an alert begins, closed when it ends.
ALTER TABLE mortar_process_steps DROP CONSTRAINT IF EXISTS mortar_process_steps_process_check;
ALTER TABLE mortar_process_steps ADD CONSTRAINT mortar_process_steps_process_check
  CHECK (process IN ('pesagem','misturador','alarme'));
