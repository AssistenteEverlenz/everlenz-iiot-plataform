-- The mixer board of a mortar plant: one card with the run, the scale against the recipe, the
-- programmed times and the day's batches, and the scale's work curve, in place of a loose card
-- per variable.
ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal','shift_board','stops','wear',
    'bagging','mortar_output','mortar_materials','mortar_yield','mortar_mixer'
  ));
