-- "Manter conectado": a session created with it lasts 30 days, renewed while it is used, and
-- has no idle limit, so a wall display or an operator's screen is not logged out mid-shift.
-- Without it a session keeps the 4 h idle and 12 h absolute limits. Logout, deactivating the
-- user and changing the password still end it.
ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS persistent boolean NOT NULL DEFAULT false;
