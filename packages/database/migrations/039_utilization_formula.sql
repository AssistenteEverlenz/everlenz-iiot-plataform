-- The plant's own formula for "Aproveitamento da máquina": which state times go above the line
-- and which below, as {"numerator": [...], "denominator": [...]} with states among producing,
-- idle, manual and offline. NULL is the default producing ÷ (producing + idle). Migration 038's
-- utilization_basis='stopped' still reads as producing ÷ (producing + idle + manual).
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS utilization_formula jsonb;
