CREATE TABLE IF NOT EXISTS operation_view_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  layout_columns smallint NOT NULL DEFAULT 2 CHECK (layout_columns BETWEEN 1 AND 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_operation_cards (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id) ON DELETE CASCADE
);
