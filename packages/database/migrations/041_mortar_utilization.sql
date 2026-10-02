-- How a mortar line's "Disponibilidade dos bicos" is counted, per equipment, like the ceramic
-- utilization formula (migration 039): null is ensacando / (ensacando + ociosa); otherwise a
-- formula the plant writes over the period's state times (argamassa.horas_*), whose result is
-- the percentage itself. A new column on a table already granted: nothing else to fix by hand.
ALTER TABLE mortar_settings ADD COLUMN IF NOT EXISTS utilization_formula text;
