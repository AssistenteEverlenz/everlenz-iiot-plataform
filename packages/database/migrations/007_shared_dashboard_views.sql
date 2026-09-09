-- A dashboard belongs to the equipment and is shared by every authorized user.
-- Preserve the most recently edited master view before retiring per-user copies.
CREATE TEMP TABLE dashboard_views_to_share ON COMMIT DROP AS
SELECT DISTINCT ON (c.dashboard_id)
 c.tenant_id,c.dashboard_id,c.refresh_ms,c.time_window_minutes,c.widgets
FROM user_dashboard_configs c
JOIN app_users u ON u.id=c.user_id AND u.tenant_id=c.tenant_id
ORDER BY c.dashboard_id,(u.role='master') DESC,c.updated_at DESC,c.user_id;

UPDATE dashboards d
SET refresh_ms=c.refresh_ms,time_window_minutes=c.time_window_minutes,updated_at=now()
FROM dashboard_views_to_share c
WHERE d.id=c.dashboard_id AND d.tenant_id=c.tenant_id;

DELETE FROM dashboard_widgets w
USING dashboard_views_to_share c
WHERE w.dashboard_id=c.dashboard_id AND w.tenant_id=c.tenant_id;

INSERT INTO dashboard_widgets(
 id,tenant_id,dashboard_id,device_id,tag_id,widget_type,title,position,width,config
)
SELECT
 (entry.item->>'id')::uuid,c.tenant_id,c.dashboard_id,(entry.item->>'device_id')::uuid,
 NULLIF(entry.item->>'tag_id','')::uuid,entry.item->>'widget_type',entry.item->>'title',
 (entry.ordinality-1)::integer,COALESCE(entry.item->>'width','medium'),
 COALESCE(entry.item->'config','{}'::jsonb)
FROM dashboard_views_to_share c
CROSS JOIN LATERAL jsonb_array_elements(c.widgets) WITH ORDINALITY AS entry(item,ordinality);

DELETE FROM user_dashboard_configs;
