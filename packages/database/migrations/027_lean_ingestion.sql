-- Lean ingestion: the raw MQTT message is kept only for diagnosis, and a reading is stored only
-- when its value changes (plus a keyframe per hour and a heartbeat that proves the link).
--
-- A sample no longer needs a stored raw message: raw_message_id becomes a plain message id that
-- groups the readings of one message (drawn from the raw id sequence), so the foreign key goes.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'public.telemetry_samples'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.mqtt_messages_raw'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.telemetry_samples DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

-- The bytes as hex are needed only when the payload is not valid text: a readable message is
-- kept once, as text.
ALTER TABLE mqtt_messages_raw ALTER COLUMN payload_hex DROP NOT NULL;

-- Until when the device's raw messages are recorded (diagnosis switched on from the platform).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS raw_capture_until timestamptz;

-- Messages per minute, counted where every message already lands, instead of counting raw rows.
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS minute_bucket timestamptz;
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS minute_count integer NOT NULL DEFAULT 0;
ALTER TABLE device_status ADD COLUMN IF NOT EXISTS previous_minute_count integer NOT NULL DEFAULT 0;
