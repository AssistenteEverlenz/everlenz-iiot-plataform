-- Quick analytic charts over a production metric: product share (donut) and bars by
-- product or by day, vertical or horizontal. They reuse the production statistics, the
-- per-chart period filter and hidden products; only the allowed widget types change.
ALTER TABLE dashboard_widgets DROP CONSTRAINT dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal'
  ));
