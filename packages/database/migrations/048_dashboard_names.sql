-- A panel is named after its machine alone (2026-10-16). "Gestão à Vista · " was in front of
-- every panel name, and every panel is a gestão à vista: it said nothing and pushed the name
-- of the plant to the middle of the line. New panels are created with the machine's name;
-- this takes the prefix off the existing ones.
UPDATE dashboards
SET name = substr(name, length('Gestão à Vista · ') + 1)
WHERE name LIKE 'Gestão à Vista · %' AND length(name) > length('Gestão à Vista · ');
