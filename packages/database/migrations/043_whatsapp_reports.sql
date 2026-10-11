-- The daily production summary sent on WhatsApp, through n8n.
--
-- A person gives a phone and chooses to receive it. Once every shift of a production day is over
-- and the line has gone quiet (overtime included), the platform writes one message per person per
-- day into this queue. n8n takes them one at a time, every few minutes, and reports back: the
-- queue, not n8n, decides the pace, so a misconfigured schedule never floods the number and gets
-- it banned.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS whatsapp_daily boolean NOT NULL DEFAULT false;
-- From when the person receives it: days that closed before are never sent.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS whatsapp_since timestamptz;

-- The "Resumo da operação" a panel opens with can be turned off for the whole platform.
ALTER TABLE tenant_branding ADD COLUMN IF NOT EXISTS briefing_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS production_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  -- 'daily' is the summary of a closed day; 'test' is the one sent from the user's screen.
  kind text NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily', 'test')),
  production_date date NOT NULL,
  phone text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  -- Not before this moment (the sending window opens at 07:00).
  due_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One summary per person per day, however many times the job looks.
CREATE UNIQUE INDEX IF NOT EXISTS production_messages_daily
  ON production_messages (user_id, production_date) WHERE kind = 'daily';
CREATE INDEX IF NOT EXISTS production_messages_queue
  ON production_messages (status, due_at);
