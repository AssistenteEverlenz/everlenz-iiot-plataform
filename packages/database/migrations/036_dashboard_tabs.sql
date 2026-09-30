-- A panel can be divided into tabs of its own making.
--
-- A plant's panel grows until it is a single column nobody scrolls to the end of: the status
-- cards, the production board, the charts, the stops and the wear, one under the other. The
-- owner of the panel knows better than we do how to group them -- what goes on the screen the
-- shift leader watches, and what belongs on the one maintenance opens -- so the tabs are his
-- to create, name and order.
--
-- A panel with no tabs is the normal case and stays exactly as it is: every card has a null
-- tab and the strip is not drawn at all.
CREATE TABLE IF NOT EXISTS dashboard_tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (dashboard_id) REFERENCES dashboards (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS dashboard_tabs_by_panel
  ON dashboard_tabs (tenant_id, dashboard_id, position);

-- Which tab a card belongs to. Null means the card has no tab yet, and those are shown on the
-- first one: deleting a tab therefore never takes its cards with it.
ALTER TABLE dashboard_widgets
  ADD COLUMN IF NOT EXISTS tab_id uuid REFERENCES dashboard_tabs (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dashboard_widgets_by_tab
  ON dashboard_widgets (dashboard_id, tab_id);
