-- The shift follows the line (2026-10-16).
--
-- Plants start before their registered shift and keep producing after it (Indusfer: 05:00 to
-- 21:00 against a 07:00-17:00 shift, a third of the day's bricks "out of shift"). A shift now
-- stretches to the production that holds before its start and after its end, and production on
-- a day without a shift is an extra shift of its own. A stop longer than this many minutes after
-- the registered end closes the stretched shift at the last thing made; 0 keeps shifts as
-- registered.
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS shift_extension_minutes integer NOT NULL DEFAULT 120
  CHECK (shift_extension_minutes BETWEEN 0 AND 720);
