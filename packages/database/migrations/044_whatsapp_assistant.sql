-- The WhatsApp assistant's inbox: the debounce of the messages people send.
--
-- People type in bursts ("quanto", "produziu", "hoje?"). Each message is written here as it
-- arrives; n8n waits a few seconds and collects. Only the run that holds the newest message of
-- the burst goes on, with the whole burst joined in order; the others stop. The same pattern as
-- the DR Fin assistant, kept in the platform's own database.
CREATE TABLE IF NOT EXISTS whatsapp_inbound (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  user_id uuid REFERENCES app_users (id) ON DELETE CASCADE,
  -- The WhatsApp address of the sender, as Evolution gives it (5527...@s.whatsapp.net).
  jid text NOT NULL,
  message_id text,
  text text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS whatsapp_inbound_pending ON whatsapp_inbound (jid, id) WHERE processed_at IS NULL;
-- The same message delivered twice by Evolution is kept once.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_inbound_message ON whatsapp_inbound (jid, message_id)
  WHERE message_id IS NOT NULL;
