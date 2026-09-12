import type { DashboardWidget } from './data';

// Configurable TV: the shape of its screens and cards (API: /dashboards/:id/tv) and the default
// screens a dashboard's TV shows until the master configures it.

export type TvCardKind =
  | 'widget'
  | 'tv_kpis'
  | 'tv_curve'
  | 'tv_daymix'
  | 'tv_week'
  | 'tv_state'
  | 'tv_alert';
export interface TvCard {
  kind: TvCardKind;
  widget_id: string | null;
  /** Grid placement: column (1–12) and row, width in columns and height in rows. */
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}
export interface TvScreen {
  name: string;
  duration_seconds: number;
  /** Rows of the grid: the screen height divided in equal rows. */
  rows: number;
  cards: TvCard[];
}

export const TV_BLOCKS: Array<{ kind: Exclude<TvCardKind, 'widget'>; label: string; w: number; h: number }> = [
  { kind: 'tv_kpis', label: 'Números do turno', w: 8, h: 2 },
  { kind: 'tv_curve', label: 'Curva S do turno', w: 8, h: 6 },
  { kind: 'tv_daymix', label: 'Produção por produto · hoje', w: 4, h: 6 },
  { kind: 'tv_week', label: 'Meta da semana', w: 12, h: 4 },
  { kind: 'tv_state', label: 'Estado da máquina', w: 4, h: 3 },
  { kind: 'tv_alert', label: 'Alerta de máquina parada', w: 12, h: 1 },
];

const QUICK = ['donut', 'bar_vertical', 'bar_horizontal'];

/** Default size of a dashboard card placed on the TV. */
export function widgetSize(widget: DashboardWidget) {
  if (widget.widget_type === 'gauge' || widget.widget_type === 'value' || widget.widget_type === 'status')
    return { w: 2, h: 2 };
  if (widget.widget_type === 'shift_board') return { w: 12, h: 10 };
  return { w: 6, h: 6 };
}

export function cardLabel(card: TvCard, widgets: DashboardWidget[]) {
  if (card.kind === 'widget')
    return widgets.find((widget) => widget.id === card.widget_id)?.title ?? 'Card removido do painel';
  return TV_BLOCKS.find((block) => block.kind === card.kind)?.label ?? card.kind;
}

/** The TV as it is without configuration: the shift page, then the product charts. */
export function defaultScreens(widgets: DashboardWidget[]): TvScreen[] {
  const gauges = widgets.filter((widget) => widget.widget_type === 'gauge' && widget.tag_id).slice(0, 2);
  const quick = widgets
    .filter((widget) => QUICK.includes(widget.widget_type) && widget.tag_id)
    .slice(0, 4);
  const kpisWidth = 12 - gauges.length * 2;
  const turno: TvCard[] = [
    { kind: 'tv_kpis', widget_id: null, x: 1, y: 1, w: kpisWidth, h: 2, config: {} },
    ...gauges.map((gauge, index) => ({
      kind: 'widget' as const,
      widget_id: gauge.id,
      x: kpisWidth + 1 + index * 2,
      y: 1,
      w: 2,
      h: 2,
      config: {},
    })),
    { kind: 'tv_curve', widget_id: null, x: 1, y: 3, w: 8, h: 6, config: {} },
    { kind: 'tv_daymix', widget_id: null, x: 9, y: 3, w: 4, h: 6, config: {} },
    { kind: 'tv_week', widget_id: null, x: 1, y: 9, w: 12, h: 4, config: {} },
  ];
  const screens: TvScreen[] = [{ name: 'Turno', duration_seconds: 20, rows: 12, cards: turno }];
  if (quick.length) {
    const places =
      quick.length === 1
        ? [[1, 1, 12, 12]]
        : quick.length === 2
          ? [
              [1, 1, 6, 12],
              [7, 1, 6, 12],
            ]
          : quick.length === 3
            ? [
                [1, 1, 6, 12],
                [7, 1, 6, 6],
                [7, 7, 6, 6],
              ]
            : [
                [1, 1, 6, 6],
                [7, 1, 6, 6],
                [1, 7, 6, 6],
                [7, 7, 6, 6],
              ];
    screens.push({
      name: 'Produtos',
      duration_seconds: 20,
      rows: 12,
      cards: quick.map((widget, index) => ({
        kind: 'widget',
        widget_id: widget.id,
        x: places[index][0],
        y: places[index][1],
        w: places[index][2],
        h: places[index][3],
        config: {},
      })),
    });
  }
  return screens;
}

/** First place where a w×h card fits on a screen, scanning rows then columns. */
export function freePlace(screen: TvScreen, w: number, h: number) {
  const taken = (x: number, y: number) =>
    screen.cards.some(
      (card) => x < card.x + card.w && x + w > card.x && y < card.y + card.h && y + h > card.y,
    );
  const width = Math.min(12, w);
  const height = Math.min(screen.rows, h);
  for (let y = 1; y + height - 1 <= screen.rows; y += 1)
    for (let x = 1; x + width - 1 <= 12; x += 1) if (!taken(x, y)) return { x, y, w: width, h: height };
  return { x: 1, y: 1, w: width, h: height };
}
