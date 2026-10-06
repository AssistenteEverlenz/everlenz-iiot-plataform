-- How each person uses the platform, for the master alone to read.
--
-- The sessions table only knows the open sessions (a logout deletes its row) and the users table
-- only the last login, so nothing said who comes back, for how long or to see what. The browser
-- now reports once a minute while the platform is on screen: which page, whether the person
-- touched it in the last two minutes, and whether it is a TV board running on a wall. One row per
-- person per minute, so a day of someone at work is a few hundred small rows.
CREATE TABLE IF NOT EXISTS usage_minutes (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  minute timestamptz NOT NULL,
  path text NOT NULL,
  -- Touched the page (mouse, key, scroll, tap) in the last two minutes.
  active boolean NOT NULL DEFAULT false,
  -- A TV board: on screen for hours with nobody in front of it, counted apart.
  tv boolean NOT NULL DEFAULT false,
  -- 'desktop', 'mobile' or 'tv', from the screen and the browser.
  device text NOT NULL DEFAULT 'desktop',
  PRIMARY KEY (user_id, minute)
);
CREATE INDEX IF NOT EXISTS usage_minutes_by_tenant ON usage_minutes (tenant_id, minute DESC);

-- Every successful login, with where it came from: a logout no longer erases the history.
CREATE TABLE IF NOT EXISTS usage_logins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  persistent boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS usage_logins_by_user ON usage_logins (tenant_id, user_id, at DESC);
