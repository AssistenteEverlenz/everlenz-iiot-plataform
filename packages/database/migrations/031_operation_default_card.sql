-- A plant card the group chose as its model: "Restaurar padrão" brings this one back instead of
-- the built-in layout, so a card arranged once can be handed to every other plant.
ALTER TABLE operation_view_settings ADD COLUMN IF NOT EXISTS default_card jsonb;
