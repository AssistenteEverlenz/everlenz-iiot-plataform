-- The panel gains two cards that read a whole device instead of one variable: how often the line
-- stopped (migration 032) and what the brick weight says about the die and the auger
-- (migration 033). The list of card types lives in three places -- the API schema, the picker on
-- screen and this constraint -- and the database is the one that refuses last.
ALTER TABLE dashboard_widgets DROP CONSTRAINT dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type IN (
    'value','line','gauge','status','production','oee','pareto',
    'donut','bar_vertical','bar_horizontal','shift_board','stops','wear'
  ));
