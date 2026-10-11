-- Each panel tab carries an icon of its own choosing.
--
-- On a phone the tab bar shows only the icons of the closed tabs, so the icon is how a tab is
-- recognised there; on a desktop it sits beside the name. Null means the default grid icon,
-- so every tab created before this keeps looking as it did.
ALTER TABLE dashboard_tabs
  ADD COLUMN IF NOT EXISTS icon text CHECK (icon IS NULL OR length(icon) BETWEEN 1 AND 40);
