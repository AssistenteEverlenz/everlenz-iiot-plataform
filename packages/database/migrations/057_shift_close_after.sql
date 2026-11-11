-- Each shift says when its report is written (2026-11-11).
--
-- A shift's report used to wait the site's stretch limit (sites.shift_extension_minutes, 120)
-- after its end, in case the line kept producing. With back-to-back shifts that wait is idle:
-- the next shift starting stops the stretch (effective-shifts.ts). At Campo Forte Turno 1 ends
-- at 10:00 and its report only appeared at 12:00. Each shift now has its own wait, 15 minutes at
-- least so the last 5-minute blocks and a late HMI have time to arrive. 120 keeps the old
-- behaviour. A shift that closed early and then worked past the moment it closed is reopened and
-- written again by the closer.
ALTER TABLE site_shifts
  ADD COLUMN IF NOT EXISTS close_after_minutes integer NOT NULL DEFAULT 120
  CHECK (close_after_minutes BETWEEN 15 AND 720);
