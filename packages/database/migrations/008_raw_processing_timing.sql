ALTER TABLE mqtt_messages_raw ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE INDEX IF NOT EXISTS raw_pending_received
ON mqtt_messages_raw(received_at)
WHERE processing_status='pending';
