import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import type { DayFacts } from './daily-report.js';

/**
 * The two images that follow the WhatsApp summary: what the day produced, and why it did not
 * produce more. Drawn as SVG from the same facts as the text, turned into PNG on the server
 * (no browser), 1080 x 2340 so each fills a phone's screen when opened. The states keep the colours
 * of the production board; the header takes the white label's colour.
 */

export interface Brand {
  name: string;
  color: string;
}

const W = 1080;
/** A phone's whole screen (19.5:9): opened in WhatsApp, the image fills it. */
const H = 2340;
const PRODUCTION_H = H;
const PAD = 64;
const FONT = 'Inter';
/**
 * The fonts travel with the API (apps/api/fonts, next to dist/ in the image): resvg reads the
 * system's fonts through fontconfig, which the slim server image does not have, and drew every
 * text as nothing. Loaded by path, the images look the same on every machine.
 */
const FONT_DIR = fileURLToPath(new URL('../fonts/', import.meta.url));
const FONT_FILES = (() => {
  try {
    return readdirSync(FONT_DIR)
      .filter((file) => file.endsWith('.ttf'))
      .map((file) => `${FONT_DIR}${file}`);
  } catch {
    return [];
  }
})();
const INK = '#0b2028';
const MUTED = '#5f7880';
const GRID = '#e3ebed';
const STATES: Record<string, { label: string; color: string }> = {
  producing: { label: 'Produzindo', color: '#1fbf7a' },
  idle: { label: 'Ociosa', color: '#f2a93b' },
  manual: { label: 'Manual / parada', color: '#e4572e' },
  offline: { label: 'Sem comunicação', color: '#98a6ab' },
};
const GOOD = '#1d8a5f';
const WARN = '#c98a12';
const BAD = '#c0412a';
const UNITS: Record<string, { unit: string; per: string; decimals: number }> = {
  milheiros: { unit: 'milheiros', per: 'mil/h', decimals: 1 },
  tons: { unit: 't', per: 't/h', decimals: 1 },
  blocks: { unit: 'peças', per: 'peças/h', decimals: 0 },
  pallets: { unit: 'paletes', per: 'pal/h', decimals: 0 },
};
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (value: number, decimals = 0) =>
  value.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}
const dayLabel = (date: string) => {
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
};
const text = (
  x: number,
  y: number,
  content: string,
  size: number,
  options: { weight?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; spacing?: number } = {},
) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${options.weight ?? 400}" fill="${options.fill ?? INK}" text-anchor="${options.anchor ?? 'start'}"${options.spacing ? ` letter-spacing="${options.spacing}"` : ''}>${esc(content)}</text>`;

function header(f: DayFacts, brand: Brand, title: string) {
  return [
    `<rect x="0" y="0" width="${W}" height="236" fill="${brand.color}"/>`,
    text(PAD, 78, `${brand.name.toUpperCase()} · ${title}`, 24, { weight: 600, fill: '#ffffff', spacing: 3 }),
    text(PAD, 148, f.name, 54, { weight: 700, fill: '#ffffff' }),
    text(PAD, 200, `${dayLabel(f.date)} · ${f.shifts}`, 28, { fill: 'rgba(255,255,255,0.85)' }),
  ].join('');
}

function footer(brand: Brand, height = H) {
  return [
    `<line x1="${PAD}" y1="${height - 84}" x2="${W - PAD}" y2="${height - 84}" stroke="${GRID}" stroke-width="2"/>`,
    text(PAD, height - 40, `Gerado automaticamente pela plataforma ${brand.name}`, 22, { fill: MUTED }),
  ].join('');
}

/** A tile: small label over a large figure. */
function tile(x: number, y: number, width: number, label: string, value: string, unit = '', color = INK) {
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="132" rx="20" fill="#f4f8f9"/>`,
    text(x + 24, y + 44, label.toUpperCase(), 20, { weight: 600, fill: MUTED, spacing: 1.5 }),
    `<text x="${x + 24}" y="${y + 104}" font-family="${FONT}" fill="${color}"><tspan font-size="46" font-weight="700">${esc(value)}</tspan><tspan font-size="24" fill="${MUTED}" dx="8">${esc(unit)}</tspan></text>`,
  ].join('');
}

function shareColor(share: number | null) {
  if (share == null) return INK;
  return share >= 1 ? GOOD : share >= 0.9 ? WARN : BAD;
}

/** Image 1: what the day produced. */
export function productionSvg(f: DayFacts, brand: Brand) {
  const units = UNITS[f.metric] ?? UNITS.pallets;
  const d = units.decimals;
  const share = f.target ? f.made / f.target : null;
  const parts: string[] = [`<rect width="${W}" height="${PRODUCTION_H}" fill="#ffffff"/>`, header(f, brand, 'PRODUÇÃO DO DIA')];

  // The figure of the day and the target.
  let y = 330;
  parts.push(text(PAD, y, 'PRODUZIDO NO DIA', 22, { weight: 600, fill: MUTED, spacing: 2 }));
  parts.push(
    `<text x="${PAD}" y="${y + 100}" font-family="${FONT}" fill="${INK}"><tspan font-size="112" font-weight="800">${esc(num(f.made, d))}</tspan><tspan font-size="38" fill="${MUTED}" dx="16">${esc(units.unit)}</tspan></text>`,
  );
  if (f.target && share != null) {
    const verdict = share >= 1 ? 'META BATIDA' : `FALTARAM ${num(f.target - f.made, d)}`;
    const pillWidth = 40 + verdict.length * 17;
    parts.push(`<rect x="${W - PAD - pillWidth}" y="${y + 28}" width="${pillWidth}" height="56" rx="28" fill="${shareColor(share)}"/>`);
    parts.push(text(W - PAD - pillWidth / 2, y + 66, verdict, 26, { weight: 700, fill: '#ffffff', anchor: 'middle' }));
    y += 150;
    const barWidth = W - PAD * 2;
    parts.push(`<rect x="${PAD}" y="${y}" width="${barWidth}" height="22" rx="11" fill="${GRID}"/>`);
    parts.push(`<rect x="${PAD}" y="${y}" width="${Math.max(22, barWidth * Math.min(1, share))}" height="22" rx="11" fill="${shareColor(share)}"/>`);
    parts.push(text(PAD, y + 62, `Meta ${num(f.target, d)} ${units.unit}`, 26, { fill: MUTED }));
    parts.push(text(W - PAD, y + 62, `${Math.round(share * 100)}% da meta`, 26, { weight: 700, fill: shareColor(share), anchor: 'end' }));
    y += 100;
  } else y += 140;

  // Each shift, when the day has more than one.
  if (f.perShift.length) {
    const width = (W - PAD * 2 - 24 * (f.perShift.length - 1)) / f.perShift.length;
    f.perShift.forEach((shift, index) => {
      const x = PAD + index * (width + 24);
      const shiftShare = shift.target ? shift.made / shift.target : null;
      parts.push(`<rect x="${x}" y="${y}" width="${width}" height="96" rx="18" fill="none" stroke="${GRID}" stroke-width="2"/>`);
      parts.push(text(x + 22, y + 38, `${shift.name} · ${shift.span}`, 22, { fill: MUTED }));
      parts.push(text(x + 22, y + 78, `${num(shift.made, d)} ${units.unit}`, 32, { weight: 700 }));
      if (shiftShare != null)
        parts.push(text(x + width - 22, y + 78, `${Math.round(shiftShare * 100)}%`, 30, { weight: 700, fill: shareColor(shiftShare), anchor: 'end' }));
    });
    y += 124;
  }

  // Four figures.
  const tileWidth = (W - PAD * 2 - 24 * 3) / 4;
  const tiles: Array<[string, string, string]> = [
    ['Milheiros', num(f.milheiros, 1), ''],
    ['Toneladas', num(f.tons, 1), 't'],
    ['Ritmo', num(f.pacePerHour, d), units.per],
    ['Aproveit.', f.utilization == null ? '—' : `${Math.round(f.utilization * 100)}`, '%'],
  ];
  tiles.forEach(([label, value, unit], index) => parts.push(tile(PAD + index * (tileWidth + 24), y, tileWidth, label, value, unit)));
  y += 180;

  y = sCurve(parts, f, brand, y, units.unit, d, Math.round((PRODUCTION_H - 120 - y) * 0.48));

  // Hour by hour.
  const first = f.firstHour;
  const last = f.lastHour >= f.firstHour ? f.lastHour : f.lastHour + 24;
  const hours: Array<{ hour: number; made: number }> = [];
  for (let hour = first; hour <= last; hour += 1)
    hours.push({ hour: hour % 24, made: f.hours.find((h) => h.hour === hour % 24)?.made ?? 0 });
  parts.push(text(PAD, y, 'PRODUÇÃO HORA A HORA', 22, { weight: 600, fill: MUTED, spacing: 2 }));
  // Room above the bars for the best hour's figure, under the title.
  const chartTop = y + 64;
  const chartHeight = PRODUCTION_H - 120 - chartTop - 60;
  const chartLeft = PAD;
  const chartWidth = W - PAD * 2;
  const top = Math.max(...hours.map((h) => h.made), 1);
  const slot = chartWidth / Math.max(1, hours.length);
  const best = hours.reduce((winner, h) => (h.made > winner.made ? h : winner), hours[0] ?? { hour: 0, made: 0 });
  for (const fraction of [0.5, 1]) {
    const gy = chartTop + chartHeight * (1 - fraction);
    parts.push(`<line x1="${chartLeft}" y1="${gy}" x2="${chartLeft + chartWidth}" y2="${gy}" stroke="${GRID}" stroke-width="2" stroke-dasharray="6 8"/>`);
    // A small day rounds half and whole to the same figure: one label is enough.
    if (fraction === 1 || num(top * fraction, d) !== num(top, d))
      parts.push(text(chartLeft + chartWidth, gy - 8, num(top * fraction, d), 18, { fill: MUTED, anchor: 'end' }));
  }
  hours.forEach((h, index) => {
    const height = (h.made / top) * chartHeight;
    const x = chartLeft + index * slot + slot * 0.18;
    const width = slot * 0.64;
    const isBest = h === best && h.made > 0;
    parts.push(`<rect x="${x}" y="${chartTop + chartHeight - height}" width="${width}" height="${Math.max(height, 2)}" rx="6" fill="${isBest ? brand.color : '#9fc3d6'}"/>`);
    // Every hour's figure over its bar, the best one in the accent colour.
    parts.push(text(x + width / 2, chartTop + chartHeight - Math.max(height, 2) - 12, num(h.made, d), hours.length > 18 ? 18 : 22, { weight: 700, fill: isBest ? brand.color : INK, anchor: 'middle' }));
    if (hours.length <= 12 || index % 2 === 0)
      parts.push(text(x + width / 2, chartTop + chartHeight + 32, `${String(h.hour).padStart(2, '0')}h`, 20, { fill: MUTED, anchor: 'middle' }));
  });
  parts.push(`<line x1="${chartLeft}" y1="${chartTop + chartHeight}" x2="${chartLeft + chartWidth}" y2="${chartTop + chartHeight}" stroke="#b7c6cb" stroke-width="2"/>`);
  parts.push(footer(brand, PRODUCTION_H));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PRODUCTION_H}" viewBox="0 0 ${W} ${PRODUCTION_H}">${parts.join('')}</svg>`;
}

/**
 * The production board's S curve: the planned line (dashed) and the actual one over its area,
 * both accumulated through the day, with where each ended. Returns where the next section starts.
 */
function sCurve(parts: string[], f: DayFacts, brand: Brand, y: number, unit: string, d: number, room: number) {
  const points = f.curve;
  if (points.length < 2) return y;
  parts.push(text(PAD, y, `CURVA S · ${unit.toUpperCase()} ACUMULADOS`, 22, { weight: 600, fill: MUTED, spacing: 2 }));
  const actual = points.filter((point) => point.actual != null);
  const planned = points.filter((point) => point.planned != null);
  // Legend on the title's line, at the right.
  const legend: Array<[string, string, boolean]> = [['realizado', brand.color, false]];
  if (planned.length > 1) legend.push(['planejado', MUTED, true]);
  let lx = W - PAD;
  for (const [label, color, dashed] of legend.reverse()) {
    parts.push(text(lx, y, label, 20, { fill: MUTED, anchor: 'end' }));
    lx -= label.length * 11 + 12;
    parts.push(`<line x1="${lx - 34}" y1="${y - 7}" x2="${lx}" y2="${y - 7}" stroke="${color}" stroke-width="5" stroke-linecap="round"${dashed ? ' stroke-dasharray="8 8"' : ''}/>`);
    lx -= 34 + 28;
  }
  const top = y + 48;
  // Room under the chart for the hours and the states' legend.
  const height = Math.max(330, room - 48 - 150);
  const left = PAD;
  // Room at the right for where the lines ended.
  const width = W - PAD * 2 - 150;
  const start = new Date(points[0].t).getTime();
  const end = new Date(points.at(-1)!.t).getTime();
  const highest = Math.max(1, ...points.map((point) => Math.max(point.planned ?? 0, point.actual ?? 0)));
  const ceiling = highest * 1.08;
  const px = (t: string) => left + ((new Date(t).getTime() - start) / Math.max(1, end - start)) * width;
  const py = (value: number) => top + height - (value / ceiling) * height;
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    const gy = py(highest * fraction);
    parts.push(`<line x1="${left}" y1="${gy}" x2="${left + width}" y2="${gy}" stroke="${GRID}" stroke-width="2" stroke-dasharray="6 8"/>`);
  }
  const path = (list: typeof points, key: 'planned' | 'actual') =>
    list.map((point, index) => `${index ? 'L' : 'M'}${px(point.t).toFixed(1)},${py(point[key]!).toFixed(1)}`).join('');
  // The area under the actual line takes the machine's state in each stretch, as on the board.
  const timelineStart = new Date(f.timelineStart).getTime();
  const stateAt = (at: number) => {
    const index = Math.floor((at - timelineStart) / 300_000);
    return index >= 0 && index < f.timeline.length ? f.timeline[index] : null;
  };
  // Stretches in the same state are one shape, so no seams show between the five minutes.
  const stateOf = (index: number) => stateAt(new Date(actual[index].t).getTime() + 150_000);
  let runStart = 0;
  for (let index = 1; index < actual.length; index += 1) {
    const state = stateOf(runStart);
    if (index < actual.length - 1 && stateOf(index) === state) continue;
    if (state) {
      const run = actual.slice(runStart, index + 1);
      const line = run.map((point, at) => `${at ? 'L' : 'M'}${px(point.t).toFixed(1)},${py(point.actual!).toFixed(1)}`).join('');
      parts.push(`<path d="${line}L${px(run.at(-1)!.t).toFixed(1)},${top + height}L${px(run[0].t).toFixed(1)},${top + height}Z" fill="${STATES[state].color}" fill-opacity="0.55"/>`);
    }
    runStart = index;
  }
  if (planned.length > 1)
    parts.push(`<path d="${path(planned, 'planned')}" fill="none" stroke="${MUTED}" stroke-width="4" stroke-dasharray="10 10" stroke-linejoin="round"/>`);
  if (actual.length > 1)
    parts.push(`<path d="${path(actual, 'actual')}" fill="none" stroke="${brand.color}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`);
  parts.push(`<line x1="${left}" y1="${top + height}" x2="${left + width}" y2="${top + height}" stroke="#b7c6cb" stroke-width="2"/>`);
  // Where each line ended, at the right; kept apart when they end close together.
  const ends: Array<{ value: number; x: number; color: string; label: string }> = [];
  if (actual.length) ends.push({ value: actual.at(-1)!.actual!, x: px(actual.at(-1)!.t), color: brand.color, label: 'realizado' });
  if (planned.length > 1) ends.push({ value: planned.at(-1)!.planned!, x: px(planned.at(-1)!.t), color: MUTED, label: 'meta' });
  const placed = ends.map((item) => ({ ...item, y: py(item.value) }));
  if (placed.length === 2 && Math.abs(placed[0].y - placed[1].y) < 60) {
    const middle = (placed[0].y + placed[1].y) / 2;
    const upper = placed[0].value >= placed[1].value ? 0 : 1;
    placed[upper].y = middle - 30;
    placed[1 - upper].y = middle + 30;
  }
  for (const item of placed) {
    parts.push(`<circle cx="${item.x}" cy="${py(item.value)}" r="8" fill="${item.color}"/>`);
    parts.push(text(left + width + 20, item.y + 4, num(item.value, d), 28, { weight: 700, fill: item.color === MUTED ? INK : item.color }));
    parts.push(text(left + width + 20, item.y + 28, item.label, 18, { fill: MUTED }));
  }
  // Hours along the bottom, plant time.
  const span = (end - start) / 3600_000;
  const every = span > 12 ? 3 : span > 6 ? 2 : 1;
  const firstHour = Math.ceil(start / 3600_000) * 3600_000;
  for (let at = firstHour; at <= end; at += 3600_000) {
    if (Math.round((at - firstHour) / 3600_000) % every) continue;
    const hour = new Date(at - 3 * 3600_000).getUTCHours();
    parts.push(text(left + ((at - start) / Math.max(1, end - start)) * width, top + height + 32, `${String(hour).padStart(2, '0')}h`, 20, { fill: MUTED, anchor: 'middle' }));
  }
  // What the area's colours mean.
  let sx = PAD;
  for (const key of ['producing', 'idle', 'manual', 'offline']) {
    parts.push(`<rect x="${sx}" y="${top + height + 62}" width="22" height="22" rx="6" fill="${STATES[key].color}"/>`);
    parts.push(text(sx + 32, top + height + 80, STATES[key].label, 22, { fill: MUTED }));
    sx += 32 + STATES[key].label.length * 12 + 40;
  }
  return top + height + 170;
}

/** Image 2: why it did not produce more. */
export function stopsSvg(f: DayFacts, brand: Brand) {
  const units = UNITS[f.metric] ?? UNITS.pallets;
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`, header(f, brand, 'PARADAS DO DIA')];
  let y = 330;
  parts.push(text(PAD, y, 'TEMPO PARADO NO TURNO', 22, { weight: 600, fill: MUTED, spacing: 2 }));
  parts.push(text(PAD, y + 100, duration(f.stoppedSeconds), 112, { weight: 800 }));
  const lost = (f.stoppedSeconds / 3600) * f.pacePerHour;
  parts.push(
    text(
      W - PAD,
      y + 52,
      `${f.stops} parada${f.stops === 1 ? '' : 's'}`,
      34,
      { weight: 700, anchor: 'end' },
    ),
  );
  if (f.microStops > 0)
    parts.push(text(W - PAD, y + 90, `+${f.microStops} microparadas (menos de 3 min)`, 22, { fill: MUTED, anchor: 'end' }));
  if (lost > 0)
    parts.push(text(W - PAD, y + 132, `≈ ${num(lost, units.decimals)} ${units.unit} a menos`, 28, { weight: 600, fill: BAD, anchor: 'end' }));
  y += 170;

  // The shift as a strip, five minutes per cell.
  parts.push(text(PAD, y, 'A MÁQUINA AO LONGO DO TURNO', 22, { weight: 600, fill: MUTED, spacing: 2 }));
  y += 26;
  const STRIP = 96;
  const stripWidth = W - PAD * 2;
  const cell = stripWidth / Math.max(1, f.timeline.length);
  parts.push(`<rect x="${PAD}" y="${y}" width="${stripWidth}" height="${STRIP}" rx="12" fill="${GRID}"/>`);
  // Runs of the same state drawn as one rectangle.
  let runStart = 0;
  f.timeline.forEach((state, index) => {
    const next = f.timeline[index + 1];
    if (next === state) return;
    parts.push(`<rect x="${PAD + runStart * cell}" y="${y}" width="${(index - runStart + 1) * cell}" height="${STRIP}" fill="${STATES[state]?.color ?? STATES.offline.color}"/>`);
    runStart = index + 1;
  });
  const span = f.lastHour >= f.firstHour ? f.lastHour - f.firstHour + 1 : f.lastHour + 25 - f.firstHour;
  const marks = span > 12 ? 4 : 2;
  for (let offset = 0; offset <= span; offset += marks) {
    const x = PAD + (offset / span) * stripWidth;
    parts.push(text(Math.min(x, W - PAD), y + STRIP + 36, `${String((f.firstHour + offset) % 24).padStart(2, '0')}h`, 20, { fill: MUTED, anchor: offset === 0 ? 'start' : offset >= span ? 'end' : 'middle' }));
  }
  y += STRIP + 86;
  let lx = PAD;
  for (const key of ['producing', 'idle', 'manual', 'offline']) {
    parts.push(`<rect x="${lx}" y="${y - 18}" width="22" height="22" rx="6" fill="${STATES[key].color}"/>`);
    parts.push(text(lx + 32, y, STATES[key].label, 22, { fill: MUTED }));
    lx += 32 + STATES[key].label.length * 12 + 40;
  }
  y += 70;

  // Time by reason.
  parts.push(text(PAD, y, 'POR MOTIVO', 22, { weight: 600, fill: MUTED, spacing: 2 }));
  y += 24;
  const reasons: Array<[string, number]> = [
    ['idle', f.reasons.idle],
    ['manual', f.reasons.manual],
    ['offline', f.reasons.offline],
  ];
  const most = Math.max(...reasons.map(([, seconds]) => seconds), 1);
  const total = Math.max(1, reasons.reduce((sum, [, seconds]) => sum + seconds, 0));
  for (const [key, seconds] of reasons) {
    const labelWidth = 290;
    const barWidth = W - PAD * 2 - labelWidth - 210;
    parts.push(text(PAD, y + 40, STATES[key].label, 28, { weight: 600 }));
    parts.push(`<rect x="${PAD + labelWidth}" y="${y + 16}" width="${barWidth}" height="30" rx="15" fill="${GRID}"/>`);
    parts.push(`<rect x="${PAD + labelWidth}" y="${y + 16}" width="${Math.max(seconds > 0 ? 30 : 0, (seconds / most) * barWidth)}" height="30" rx="15" fill="${STATES[key].color}"/>`);
    parts.push(text(W - PAD, y + 41, `${duration(seconds)} · ${Math.round((seconds / total) * 100)}%`, 26, { weight: 700, anchor: 'end' }));
    y += 76;
  }
  y += 50;

  // The longest stops.
  parts.push(text(PAD, y, 'MAIORES PARADAS', 22, { weight: 600, fill: MUTED, spacing: 2 }));
  y += 20;
  if (!f.topStops.length) parts.push(text(PAD, y + 50, 'Nenhuma parada no turno.', 28, { fill: MUTED }));
  // As many of the longest stops as the screen holds above the footer.
  const ROW = 84;
  const room = Math.max(1, Math.floor((H - 110 - (y + 14)) / ROW));
  f.topStops.slice(0, room).forEach((stop, index) => {
    const rowY = y + index * ROW;
    parts.push(`<rect x="${PAD}" y="${rowY + 14}" width="${W - PAD * 2}" height="${ROW - 10}" rx="16" fill="${index % 2 ? '#ffffff' : '#f4f8f9'}"/>`);
    parts.push(text(PAD + 22, rowY + 62, `${index + 1}º`, 24, { weight: 600, fill: MUTED }));
    parts.push(`<rect x="${PAD + 76}" y="${rowY + 41}" width="22" height="22" rx="5" fill="${STATES[stop.state]?.color ?? STATES.offline.color}"/>`);
    parts.push(text(PAD + 114, rowY + 62, stop.at, 30, { weight: 700 }));
    parts.push(text(PAD + 222, rowY + 62, STATES[stop.state]?.label ?? stop.state, 28, { fill: MUTED }));
    parts.push(text(W - PAD - 24, rowY + 62, duration(stop.seconds), 32, { weight: 700, anchor: 'end' }));
  });
  parts.push(footer(brand));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

/** SVG to PNG, with the fonts shipped with the API only (the same everywhere). */
export function toPng(svg: string) {
  if (!FONT_FILES.length) throw new Error(`Fontes das imagens não encontradas em ${FONT_DIR}`);
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: 'Inter' },
  })
    .render()
    .asPng();
}

/** Both images of a machine's day, as PNG. */
export function dayImages(f: DayFacts, brand: Brand) {
  return [
    { name: 'producao', png: toPng(productionSvg(f, brand)) },
    { name: 'paradas', png: toPng(stopsSvg(f, brand)) },
  ];
}
