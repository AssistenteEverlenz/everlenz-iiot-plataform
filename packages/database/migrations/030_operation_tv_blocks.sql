-- The operations TV holds more than plants: a card is now a kind. Beside 'plant' (a ceramic's
-- card, which keeps its device) come the group's blocks — the fleet tiles, the totals across
-- the plants on screen, the ranking, the state mix, the map and the stopped-plant strip.
ALTER TABLE operation_tv_cards ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'plant';
ALTER TABLE operation_tv_cards ALTER COLUMN device_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE operation_tv_cards
    ADD CONSTRAINT operation_tv_cards_kind_device CHECK (kind <> 'plant' OR device_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
