import { describe, expect, it } from 'vitest';
import {
  composeComparison,
  composeNotFound,
  composeNow,
  composePeriod,
  composeStops,
  type DayFigures,
  type NowFacts,
} from '../apps/api/src/assistant-answers.js';
import type { DayFacts } from '../apps/api/src/daily-report.js';

/** The WhatsApp assistant's answers: written by rule, in the daily summary's layout. */
const FRAME = '#'.repeat(26);
const RULE = '_'.repeat(38);

const now = (overrides: Partial<NowFacts> = {}): NowFacts => ({
  name: 'Cerâmica Oliveira',
  metric: 'pallets',
  clock: '08:51',
  state: 'producing',
  since: '2026-10-14T11:32:00.000Z',
  product: '9x19x19',
  made: 52,
  target: { value: 250, plannedToNow: 71, projected: 174, requiredPerHour: 28 },
  pacePerHour: 17,
  utilization: 0.68,
  yesterday: 44,
  shiftStatus: 'running',
  ...overrides,
});

const today = (overrides: Partial<DayFacts> = {}) =>
  ({
    name: 'Cerâmica Oliveira',
    date: '2026-10-14',
    metric: 'pallets',
    made: 52,
    pacePerHour: 17,
    stoppedSeconds: 55 * 60,
    stops: 3,
    microStops: 8,
    longestStop: { seconds: 21 * 60, at: '06:03' },
    reasons: { idle: 30 * 60, manual: 25 * 60, offline: 0 },
    stopList: [
      { at: '06:03', seconds: 21 * 60, state: 'manual', open: false },
      { at: '07:45', seconds: 11 * 60, state: 'idle', open: false },
      { at: '08:40', seconds: 7 * 60, state: 'idle', open: true },
    ],
    average: { made: 190, pacePerHour: 15, utilization: 0.61, stoppedSeconds: 4 * 3600 },
    ...overrides,
  }) as DayFacts;

const figures = (date: string, made: number, target: number | null = 250): DayFigures => ({
  date,
  made,
  target,
  utilization: 70,
  stoppedMinutes: 200,
  pacePerHour: 18,
});

describe('respostas do assistente', () => {
  it('tells the machine now in the summary layout', () => {
    const text = composeNow(now(), today({ stopList: [] }));
    expect(text.startsWith(`${FRAME}\n🟢 *Oliveira · produzindo*\n${FRAME}`)).toBe(true);
    expect(text).toContain('*HOJE ATÉ 08:51*');
    expect(text).toContain('> 📦 *52 paletes* · 9x19x19');
    expect(text).toContain('> ⏳ Esperado agora: 71 · *19* atrás');
    expect(text).toContain('❌ Não bate a meta neste ritmo');
    expect(text).toContain('⚡ Para bater: *28 pal/h* · hoje 17');
    expect(text).toContain('🟢 Aproveitamento  - *68%* · média 61%');
    expect(text).toContain('     ↳ 3 paradas · maior: 21 min (06:03)');
    expect(text.split(RULE).length).toBe(3);
  });

  it('says since when a stop that is still open began', () => {
    expect(composeNow(now({ state: 'idle' }), today())).toContain('🟠 Ociosa desde 08:40');
  });

  it('lists the stops one by one, in the order they happened', () => {
    const text = composeStops(today(), true);
    expect(text).toContain('⛔ *Oliveira · paradas de hoje*');
    expect(text).toContain('> 🔢 *3 paradas* · +8 microparadas');
    expect(text).toContain('🟠 Ociosa - *30 min* · 55%');
    // No line for a reason that took no time.
    expect(text).not.toContain('Sem comunicação');
    const list = text.slice(text.indexOf('*UMA A UMA*'));
    expect(list.indexOf('06:03')).toBeLessThan(list.indexOf('07:45'));
    expect(list).toContain('🟠 `08:40`  Ociosa · *7 min* ⏳ _agora_');
  });

  it('keeps today apart in a period', () => {
    const text = composePeriod('Cerâmica Oliveira', 'pallets', '2026-10-12', '2026-10-14', [
      figures('2026-10-12', 260),
      figures('2026-10-13', 200),
      figures('2026-10-14', 52),
    ], '2026-10-14');
    expect(text).toContain('> 📦 *460 paletes* em 2 dias');
    expect(text).toContain('> 📊 Média *230* por dia');
    expect(text).toContain('> ⏳ Hoje até agora: *52* paletes');
    expect(text).toContain('🟢 `seg 12/10`  *260* · 104%');
    expect(text).toContain('⏳ `qua 14/10`  *52* · até agora');
  });

  it('shows a long period week by week', () => {
    const days = Array.from({ length: 20 }, (_, index) => figures(`2026-09-${String(index + 1).padStart(2, '0')}`, 200));
    expect(composePeriod('Galo', 'pallets', '2026-09-01', '2026-09-20', days)).toContain('*SEMANA A SEMANA*');
  });

  it('compares two days with the difference worked out', () => {
    const text = composeComparison('Cerâmica Oliveira', 'pallets', [figures('2026-10-09', 172), figures('2026-10-13', 201)]);
    expect(text).toContain('⚖️ *Oliveira · 09/10 x 13/10*');
    expect(text).toContain('📈 *+29 paletes* (+17%) em 13/10');
    expect(text).toContain('⚙️ Aproveitamento  - 70% → *70%*');
  });

  it('lists the machines when the one asked about is not found', () => {
    expect(composeNotFound('galo', ['Cerâmica Oliveira'])).toContain('🔹 Cerâmica Oliveira');
  });
});
