-- How the platform is used, beyond how long (2026-11-09).
--
-- usage_minutes (042) says who is on screen and for how long. It cannot say where a screen
-- confuses: a button that looks clickable and is not, a window closed the moment it opened, a
-- form started and left, a search that finds nothing. The browser now records those moments,
-- the time spent on each page and which control was used. Never what was typed: a target is a
-- control's name with its digits masked, cut to 80 characters.
--
-- Nobody reads these rows through the platform: the analysis is Everlenz's, straight from the
-- database (.claude/skills/pnl). Rows older than 90 days are deleted by the API's retention job.
CREATE TABLE IF NOT EXISTS usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  role text,
  -- One browser tab from load to close.
  session uuid NOT NULL,
  -- screen: ms on a page | click: a control used | repeat: 3 clicks in 0.8 s on one spot |
  -- dead: a click on a card where nothing reacts | modal: a window closed in under 2 s |
  -- form_abandoned: typed in a window, closed it without saving | empty_search | error
  kind text NOT NULL CHECK (kind IN ('screen','click','repeat','dead','modal','form_abandoned','empty_search','error')),
  path text NOT NULL,
  target text,
  ms integer,
  device text NOT NULL DEFAULT 'desktop' CHECK (device IN ('desktop','mobile','tv')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_by_tenant ON usage_events (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS usage_events_by_time ON usage_events (at);

-- Applied by hand in the Supabase SQL editor, where the table comes out owned by postgres,
-- exposed to the Data API and with RLS on: give it to the platform like the others. The roles
-- do not exist in plain PostgreSQL/PGlite, hence the checks.
REVOKE ALL ON TABLE public.usage_events FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.usage_events FROM %I', role_name);
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='everlenz_iiot_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_events TO everlenz_iiot_app;
  GRANT USAGE, SELECT ON SEQUENCE public.usage_events_id_seq TO everlenz_iiot_app;
 END IF;
END $$;
ALTER TABLE public.usage_events DISABLE ROW LEVEL SECURITY;
