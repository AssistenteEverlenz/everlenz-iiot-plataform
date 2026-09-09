-- Every active device owns an operational dashboard; future devices are created atomically by the API.
INSERT INTO dashboards(id,tenant_id,device_id,name,slug,description,refresh_ms,time_window_minutes,is_default)
SELECT gen_random_uuid(),d.tenant_id,d.id,'Gestão à Vista · ' || d.name,
       'gestao-a-vista-' || lower(d.device_code),
       'Painel operacional de ' || d.name,2000,60,false
FROM devices d
WHERE d.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM dashboards dashboard
    WHERE dashboard.tenant_id=d.tenant_id AND dashboard.device_id=d.id
  );
