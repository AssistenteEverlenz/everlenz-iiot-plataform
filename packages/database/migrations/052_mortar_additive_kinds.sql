-- Additive kinds the plant names itself (2026-10-24).
--
-- 051 held the kind to a fixed list. A plant pours additives that list does not know, so the kind
-- becomes the plant's own word: the platform still offers the common ones, and anything typed
-- in is kept as written.
ALTER TABLE IF EXISTS mortar_additives DROP CONSTRAINT IF EXISTS mortar_additives_kind_check;
ALTER TABLE IF EXISTS mortar_additives DROP CONSTRAINT IF EXISTS mortar_additives_kind_length;
ALTER TABLE IF EXISTS mortar_additives
  ADD CONSTRAINT mortar_additives_kind_length CHECK (length(btrim(kind)) BETWEEN 1 AND 40);
