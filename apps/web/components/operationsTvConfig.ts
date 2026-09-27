// TV of the operations page: the screens a group's wall display shows in turn, each a
// 12-column grid of plants (API: /operations/tv). Until the master arranges them, the TV fits
// every plant it can see on as few screens as possible, so nothing has to be scrolled.

export interface OperationTvCard {
  device_id: string;
  /** Grid placement: column (1–12) and row, width in columns and height in rows. */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OperationTvScreen {
  name: string;
  duration_seconds: number;
  /** Rows of the grid: the screen height divided in equal rows. */
  rows: number;
  cards: OperationTvCard[];
}

export const TV_COLUMNS = 12;
export const TV_ROWS = 12;
/** More than this on one screen and a plant is too small to read across a room. */
const MAX_PER_SCREEN = 9;

/**
 * How many columns and rows of plants fit a screen: a wall display is wider than it is tall, so
 * a count is laid out wider than square (8 plants read best as 4 by 2, never 2 by 4).
 */
export function plantGrid(count: number) {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  if (count <= 6) return { columns: 3, rows: 2 };
  if (count <= 8) return { columns: 4, rows: 2 };
  return { columns: 3, rows: 3 };
}

/** Every plant on as few screens as possible, each screen an even grid of cards. */
export function defaultScreens(deviceIds: string[]): OperationTvScreen[] {
  if (!deviceIds.length) return [];
  const pages = Math.ceil(deviceIds.length / MAX_PER_SCREEN);
  const perPage = Math.ceil(deviceIds.length / pages);
  const screens: OperationTvScreen[] = [];
  for (let page = 0; page < pages; page += 1) {
    const slice = deviceIds.slice(page * perPage, (page + 1) * perPage);
    const { columns, rows } = plantGrid(slice.length);
    const w = Math.floor(TV_COLUMNS / columns);
    const h = Math.floor(TV_ROWS / rows);
    screens.push({
      name: pages > 1 ? `Cerâmicas ${page + 1}` : 'Cerâmicas',
      duration_seconds: 20,
      rows: TV_ROWS,
      cards: slice.map((device_id, index) => ({
        device_id,
        x: (index % columns) * w + 1,
        y: Math.floor(index / columns) * h + 1,
        w,
        h,
      })),
    });
  }
  return screens;
}

/** First place where a w×h card fits on a screen, scanning rows then columns. */
export function freePlace(screen: OperationTvScreen, w: number, h: number) {
  const taken = (x: number, y: number) =>
    screen.cards.some(
      (card) => x < card.x + card.w && x + w > card.x && y < card.y + card.h && y + h > card.y,
    );
  const width = Math.min(TV_COLUMNS, w);
  const height = Math.min(screen.rows, h);
  for (let y = 1; y + height - 1 <= screen.rows; y += 1)
    for (let x = 1; x + width - 1 <= TV_COLUMNS; x += 1)
      if (!taken(x, y)) return { x, y, w: width, h: height };
  return { x: 1, y: 1, w: width, h: height };
}
