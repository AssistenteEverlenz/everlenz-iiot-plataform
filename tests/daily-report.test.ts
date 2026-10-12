import { describe, expect, it } from 'vitest';
import {
  composeDevice,
  composeMessage,
  headline,
  highlight,
  spark,
  type DayFacts,
} from '../apps/api/src/daily-report.js';

/** The WhatsApp daily summary's writing: verdict, shifts, traffic lights, the sentence. */
const day = (overrides: Partial<DayFacts> = {}): DayFacts => ({
  name: 'Cerâmica Campo Forte',
  dashboardId: 'abc',
  date: '2026-10-09',
  shifts: 'turno 06:00–17:30',
  firstHour: 6,
  lastHour: 17,
  metric: 'pallets',
  made: 224,
  milheiros: 37.6,
  pallets: 224,
  tons: 136.4,
  target: 200,
  perShift: [],
  overtime: 0,
  utilization: 0.69,
  pacePerHour: 14,
  stoppedSeconds: 5 * 3600 + 17 * 60,
  stops: 11,
  longestStop: { seconds: 47 * 60, at: '14:10' },
  hours: [
    { hour: 6, made: 18, stopped: 300 },
    { hour: 9, made: 22, stopped: 0 },
    { hour: 14, made: 12, stopped: 3000 },
    { hour: 15, made: 10, stopped: 2400 },
  ],
  previous: { date: '2026-10-08', made: 190 },
  week: [
    { date: '2026-10-06', made: 180 },
    { date: '2026-10-07', made: 200 },
    { date: '2026-10-08', made: 190 },
    { date: '2026-10-09', made: 224 },
  ],
  average: { made: 196, pacePerHour: 12, utilization: 0.72, stoppedSeconds: 3 * 3600 + 50 * 60 },
  ...overrides,
});

describe('resumo diário em texto', () => {
  it('opens with the verdict the lock screen shows', () => {
    expect(headline(day())).toBe('🟢 *Campo Forte bateu a meta: 224 paletes (112%)*');
    expect(headline(day({ made: 164 }))).toBe('🔴 *Campo Forte fechou em 82% da meta: 164 de 200 paletes*');
    expect(headline(day({ made: 185 }))).toMatch(/^🟡/);
    expect(headline(day({ target: null }))).toBe('📦 *Campo Forte produziu 224 paletes*');
  });

  it('shows each shift and the day total only when there are two shifts', () => {
    const one = composeDevice(day(), null);
    expect(one).not.toContain('Total do dia');
    const two = composeDevice(
      day({
        shifts: '2 turnos · 02:00–18:00',
        perShift: [
          { name: 'Turno 1', span: '02:00–10:00', made: 121, target: 100 },
          { name: 'Turno 2', span: '10:00–18:00', made: 103, target: 100 },
        ],
      }),
      null,
    );
    expect(two).toContain('🕐 Turno 1 _(02:00–10:00)_: `121` paletes · 121%');
    expect(two).toContain('🕐 Turno 2 _(10:00–18:00)_: `103` paletes · 103%');
    expect(two.indexOf('Total do dia')).toBeGreaterThan(two.indexOf('Turno 2'));
  });

  it('puts each machine figure against the recent average', () => {
    const text = composeDevice(day(), null);
    expect(text).toContain('🟡 Aproveitamento *69%* · média 72%');
    expect(text).toContain('🟢 Ritmo *14 pal/h* · pico às *09h* (22)');
    expect(text).toContain('🔴 *11 paradas* · 5h17 no turno · média 3h50');
    expect(text).toContain('📈 +18% sobre quinta (190)');
    expect(text).toContain('*sex █*');
  });

  it('tells what made the day, by rule', () => {
    expect(highlight(day())).toContain('Melhor dia da semana.');
    expect(highlight(day())).toContain('A tarde perdeu ritmo');
    const missed = highlight(day({ made: 170, longestStop: { seconds: 2 * 3600, at: '10:05' } }));
    expect(missed).toBe('A parada de 2h às 10:05 custou cerca de 28 paletes, quase toda a diferença para a meta.');
    expect(composeDevice(day({ made: 170 }), null)).toContain('*ONDE PERDEU*');
  });

  it('draws small bars and ranks several machines', () => {
    expect(spark([0, 5, 10])).toBe('▁▅█');
    const text = composeMessage(
      [day(), day({ name: 'Cerâmica Galo', made: 150, target: 200 })],
      'https://x',
      'daily',
    );
    expect(text.split('\n')[0]).toBe('📊 *Fechamento de sexta, 09/10*');
    expect(text).toContain('🥇 *Campo Forte* · 224 paletes · 112%');
    expect(text).toContain('🥈 *Galo* · 150 paletes · 75%');
  });
});
