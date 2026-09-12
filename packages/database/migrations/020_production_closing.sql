-- End of shift: when the machine stops counting within the last closing_minutes of a shift and
-- does not count again before it ends, the idle time after the last production is "Encerrado"
-- (cleaning, wrapping up), not idleness. Stopping earlier than that stays idle: a real loss.
-- 0 turns the rule off.
ALTER TABLE production_settings ADD COLUMN IF NOT EXISTS closing_minutes integer NOT NULL DEFAULT 30
  CHECK(closing_minutes BETWEEN 0 AND 240);
