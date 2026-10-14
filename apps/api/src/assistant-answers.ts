import type { Database } from '@iiot/database';
import { addDays, plantDate } from '@iiot/shared';
import { buildBriefing } from './briefing.js';
import { composeDay, fmt, FRAME, gatherDay, panelLink, RULE, type DayFacts } from './daily-report.js';

/**
 * The WhatsApp assistant's answers, written by the platform in the daily summary's layout: a
 * framed headline, sections in capitals, quoted figures, rules between sections. The AI in n8n
 * only understands the question; every answer about production is written here, by rule, so it
 * looks the same every time and nothing in it is invented.
 *
 *   agora        the machine at this moment (also "hoje" while the day is running);
 *   dia          a past day: the daily summary itself;
 *   paradas      a day's stops, by reason and one by one;
 *   periodo      a range of days, day by day (week by week past 16 days);
 *   comparativo  two to seven days side by side.
 *
 * One message per machine, at most four. Lines measured for a 360 px bubble, like the summary.
 */

const { UNITS, WEEKDAYS, num, duration, bar, light, short } = fmt;
const MAX_MESSAGES = 4;
/** Past this many days a period is shown week by week. */
const DAY_BY_DAY = 16;
/** Stops listed one by one; the rest are counted. */
const MAX_STOPS = 20;

const STATE: Record<string, { dot: string; label: string; now: string }> = {
  producing: { dot: '🟢', label: 'Produzindo', now: 'produzindo' },
  idle: { dot: '🟠', label: 'Ociosa', now: 'ociosa' },
  manual: { dot: '🔴', label: 'Manual / parada', now: 'parada em manual' },
  offline: { dot: '⚪', label: 'Sem comunicação', now: 'sem comunicação' },
  unknown: { dot: '⚪', label: 'Sem leitura', now: 'sem leitura' },
};
const state = (key: string) => STATE[key] ?? STATE.unknown;
const unitOf = (metric: string) => UNITS[metric] ?? UNITS.pallets;
const br = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()].slice(0, 3);
const plantClock = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(11, 16);
const signed = (value: number, decimals = 0) => `${value >= 0 ? '+' : '−'}${num(Math.abs(value), decimals)}`;
/** 🟢 target met, 🟡 within 10%, 🔴 short of it, ⚪ no target. */
const shareDot = (share: number | null) => (share == null ? '⚪' : share >= 1 ? '🟢' : share >= 0.9 ? '🟡' : '🔴');
const frame = (title: string) => [FRAME, title, FRAME, ''];

/** The machine right now, from the panel's summary and today's facts so far. */
export interface NowFacts {
  name: string;
  metric: string;
  /** Plant clock, "08:51". */
  clock: string;
  state: string;
  since: string | null;
  product: string | null;
  made: number;
  target: { value: number; plannedToNow: number; projected: number; requiredPerHour: number | null } | null;
  pacePerHour: number;
  utilization: number | null;
  yesterday: number;
  shiftStatus: string;
}

export function composeNow(n: NowFacts, today: DayFacts | null) {
  const units = unitOf(n.metric);
  const d = units.decimals;
  const s = state(n.state);
  const lines = frame(`${s.dot} *${short(n.name)} · ${s.now}*`);

  lines.push(`*HOJE ATÉ ${n.clock}*`, '');
  lines.push(`> 📦 *${num(n.made, d)} ${units.unit}*${n.product ? ` · ${n.product}` : ''}`);
  if (n.target) {
    const share = n.target.value > 0 ? n.made / n.target.value : 0;
    lines.push(`> 🎯 Meta ${num(n.target.value, d)}   ${bar(share)}  *${Math.round(share * 100)}%*`);
    const gap = n.made - n.target.plannedToNow;
    lines.push(
      `> ⏳ Esperado agora: ${num(n.target.plannedToNow, d)} · ${gap >= 0 ? `*${signed(gap, d)}* à frente` : `*${num(-gap, d)}* atrás`}`,
    );
  }
  if (n.yesterday > 0) {
    const change = Math.round((n.made / n.yesterday - 1) * 100);
    lines.push(`> ${change >= 0 ? '📈' : '📉'} ${signed(change)}% sobre ontem a esta hora (${num(n.yesterday, d)})`);
  }

  if (n.target && n.shiftStatus === 'running') {
    const hits = n.target.projected >= n.target.value;
    lines.push('', RULE, '', '*PROJEÇÃO*', '');
    lines.push(`🔮 No ritmo atual fecha em *${num(n.target.projected, d)}* ${units.unit}`);
    if (hits) lines.push('✅ Bate a meta se mantiver o ritmo');
    else {
      lines.push(`❌ Não bate a meta neste ritmo`);
      if (n.target.requiredPerHour != null)
        lines.push(`⚡ Para bater: *${num(n.target.requiredPerHour ?? 0, d)} ${units.per}* · hoje ${num(n.pacePerHour, d)}`);
    }
  } else if (n.shiftStatus !== 'running') lines.push('', '🏁 _O turno de hoje já encerrou._');

  lines.push('', RULE, '', '*MÁQUINA*', '');
  // A stop still open started when the consolidated stop did, not at its last reason change.
  const open = n.state !== 'producing' ? today?.stopList.at(-1) : undefined;
  const since = open?.open ? open.at : n.since ? plantClock(n.since) : null;
  lines.push(`${s.dot} ${s.label}${since ? ` desde ${since}` : ''}`);
  const average = today?.average;
  if (n.utilization != null)
    lines.push(
      `${light(n.utilization, average?.utilization, true)} Aproveitamento  - *${Math.round(n.utilization * 100)}%*${
        average?.utilization != null ? ` · média ${Math.round(average.utilization * 100)}%` : ''
      }`,
    );
  lines.push(
    `${light(n.pacePerHour, average?.pacePerHour, true)} Ritmo - *${num(n.pacePerHour, d)} ${units.per}*${
      average ? ` · média ${num(average.pacePerHour, d)}` : ''
    }`,
  );
  if (today) {
    lines.push(`⛔ Parada - *${duration(today.stoppedSeconds)}*`);
    lines.push(
      `     ↳ ${today.stops} parada${today.stops === 1 ? '' : 's'}${
        today.longestStop ? ` · maior: ${duration(today.longestStop.seconds)} (${today.longestStop.at})` : ''
      }`,
    );
    if (today.microStops > 0)
      lines.push(`     ↳ +${today.microStops} microparada${today.microStops === 1 ? '' : 's'} (menos de 3 min)`);
    if (today.stops > 0) lines.push('', '💬 _Peça "paradas de hoje" para ver uma a uma._');
  }
  return lines.join('\n');
}

/** A day's stops: how long, why, and each one in the order it happened. */
export function composeStops(f: DayFacts, isToday: boolean) {
  const units = unitOf(f.metric);
  const when = isToday ? 'hoje' : `${weekday(f.date)} ${br(f.date)}`;
  const lines = frame(`⛔ *${short(f.name)} · paradas de ${when}*`);

  lines.push('*RESUMO*', '');
  lines.push(`> ⏱️ *${duration(f.stoppedSeconds)}* parada no turno${isToday ? ' até agora' : ''}`);
  lines.push(
    `> 🔢 *${f.stops} parada${f.stops === 1 ? '' : 's'}*${f.microStops > 0 ? ` · +${f.microStops} microparadas` : ''}`,
  );
  const lost = (f.stoppedSeconds / 3600) * f.pacePerHour;
  if (lost >= 1) lines.push(`> 📉 ≈ ${num(lost, units.decimals)} ${units.unit} a menos`);

  const reasons: Array<[string, number]> = [
    ['idle', f.reasons.idle],
    ['manual', f.reasons.manual],
    ['offline', f.reasons.offline],
  ];
  const total = reasons.reduce((sum, [, seconds]) => sum + seconds, 0);
  if (total > 0) {
    lines.push('', RULE, '', '*POR MOTIVO*', '');
    for (const [key, seconds] of reasons)
      if (seconds >= 60)
        lines.push(`${state(key).dot} ${state(key).label} - *${duration(seconds)}* · ${Math.round((seconds / total) * 100)}%`);
  }

  lines.push('', RULE, '', '*UMA A UMA*', '');
  if (!f.stopList.length) lines.push('_Nenhuma parada de 3 min ou mais no turno._ ✅');
  for (const stop of f.stopList.slice(0, MAX_STOPS))
    lines.push(
      `${state(stop.state).dot} \`${stop.at}\`  ${state(stop.state).label} · *${duration(stop.seconds)}*${stop.open ? ' ⏳ _agora_' : ''}`,
    );
  if (f.stopList.length > MAX_STOPS) {
    const rest = f.stopList.slice(MAX_STOPS);
    lines.push(`     ↳ e mais ${rest.length} · ${duration(rest.reduce((sum, stop) => sum + stop.seconds, 0))} no total`);
  }
  if (f.microStops > 0) lines.push('', '_Microparadas (< 3 min) ficam fora da lista._');
  return lines.join('\n');
}

/** One machine's day in a period or a comparison (the lighter figures the period needs). */
export interface DayFigures {
  date: string;
  made: number;
  target: number | null;
  utilization: number | null;
  stoppedMinutes: number;
  pacePerHour: number;
}

export function composePeriod(
  name: string,
  metric: string,
  from: string,
  to: string,
  all: DayFigures[],
  today = '',
) {
  const units = unitOf(metric);
  const d = units.decimals;
  const lines = frame(`📅 *${short(name)} · ${br(from)} a ${br(to)}*`);
  if (!all.length) {
    lines.push('📭 Nenhuma produção registrada no período.', '', '_Pode ter sido um período sem turno._');
    return lines.join('\n');
  }
  // Today, while it runs, is shown apart: half a day would pull the average and the worst day down.
  const running = all.find((day) => day.date === today) ?? null;
  const days = all.filter((day) => day !== running);
  const made = days.reduce((sum, day) => sum + day.made, 0);
  const target = days.reduce((sum, day) => sum + (day.target ?? 0), 0);
  const best = [...days].sort((a, b) => b.made - a.made)[0];
  const worst = [...days].sort((a, b) => a.made - b.made)[0];
  const utilizations = days.map((day) => day.utilization).filter((value): value is number => value != null);

  lines.push('*RESUMO*', '');
  if (days.length) {
    lines.push(`> 📦 *${num(made, d)} ${units.unit}* em ${days.length} dia${days.length === 1 ? '' : 's'}`);
    if (target > 0) lines.push(`> 🎯 Meta ${num(target, d)}   ${bar(made / target)}  *${Math.round((made / target) * 100)}%*`);
    lines.push(`> 📊 Média *${num(made / days.length, d)}* por dia`);
  }
  if (running) lines.push(`> ⏳ Hoje até agora: *${num(running.made, d)}* ${units.unit}`);
  if (days.length > 1) lines.push(`> 🏆 Melhor: ${br(best.date)} (${num(best.made, d)}) · menor: ${br(worst.date)} (${num(worst.made, d)})`);

  if (days.length) {
    lines.push('', RULE, '', '*MÁQUINA*', '');
    if (utilizations.length)
      lines.push(`⚙️ Aproveitamento médio - *${Math.round(utilizations.reduce((a, b) => a + b, 0) / utilizations.length)}%*`);
    lines.push(`⛔ Parada média - *${duration((days.reduce((sum, day) => sum + day.stoppedMinutes, 0) / days.length) * 60)}* por dia`);
  }

  if (all.length <= DAY_BY_DAY) {
    lines.push('', RULE, '', '*DIA A DIA*', '');
    for (const day of all) {
      const share = day.target ? day.made / day.target : null;
      lines.push(
        day === running
          ? `⏳ \`${weekday(day.date)} ${br(day.date)}\`  *${num(day.made, d)}* · até agora`
          : `${shareDot(share)} \`${weekday(day.date)} ${br(day.date)}\`  *${num(day.made, d)}*${share == null ? '' : ` · ${Math.round(share * 100)}%`}`,
      );
    }
  } else {
    lines.push('', RULE, '', '*SEMANA A SEMANA*', '');
    const weeks = new Map<string, DayFigures[]>();
    for (const day of days) {
      const monday = addDays(day.date, -((new Date(`${day.date}T12:00:00Z`).getUTCDay() + 6) % 7));
      weeks.set(monday, [...(weeks.get(monday) ?? []), day]);
    }
    for (const [monday, list] of weeks) {
      const total = list.reduce((sum, day) => sum + day.made, 0);
      const goal = list.reduce((sum, day) => sum + (day.target ?? 0), 0);
      const share = goal > 0 ? total / goal : null;
      lines.push(
        `${shareDot(share)} \`${br(monday)}–${br(addDays(monday, 6))}\`  *${num(total, d)}* · ${list.length}d${share == null ? '' : ` · ${Math.round(share * 100)}%`}`,
      );
    }
  }
  return lines.join('\n');
}

export function composeComparison(name: string, metric: string, days: DayFigures[]) {
  const units = unitOf(metric);
  const d = units.decimals;
  const title = days.length === 2 ? `${br(days[0].date)} x ${br(days[1].date)}` : `${days.length} dias`;
  const lines = frame(`⚖️ *${short(name)} · ${title}*`);

  lines.push('*PRODUÇÃO*', '');
  const best = [...days].sort((a, b) => b.made - a.made)[0];
  for (const day of days) {
    const share = day.target ? ` · ${Math.round((day.made / day.target) * 100)}%` : '';
    lines.push(`🔹 \`${weekday(day.date)} ${br(day.date)}\`  *${num(day.made, d)}* ${units.unit}${share}${days.length > 2 && day === best ? ' 🏆' : ''}`);
  }
  if (days.length === 2) {
    const [a, b] = days;
    const diff = b.made - a.made;
    const pct = a.made > 0 ? ` (${signed(Math.round((b.made / a.made - 1) * 100))}%)` : '';
    lines.push(`${diff >= 0 ? '📈' : '📉'} *${signed(diff, d)} ${units.unit}*${pct} em ${br(b.date)}`);
  }

  lines.push('', RULE, '', '*MÁQUINA*', '');
  const series = (values: string[]) => (days.length === 2 ? `${values[0]} → *${values[1]}*` : values.join(' · '));
  lines.push(`⚙️ Aproveitamento  - ${series(days.map((day) => (day.utilization == null ? '—' : `${day.utilization}%`)))}`);
  lines.push(`⚡ Ritmo - ${series(days.map((day) => num(day.pacePerHour, d)))} ${units.per}`);
  lines.push(`⛔ Parada - ${series(days.map((day) => duration(day.stoppedMinutes * 60)))}`);
  return lines.join('\n');
}

export function composeNotFound(asked: string, devices: string[]) {
  if (!devices.length)
    return 'Nenhum equipamento está liberado para você na plataforma ainda.\n\n_O administrador pode liberar no seu usuário._';
  return [
    `Não encontrei *${asked}* entre os seus equipamentos.`,
    '',
    '*VOCÊ ACOMPANHA*',
    '',
    ...devices.map((device) => `🔹 ${device}`),
    '',
    '_Pergunte de novo citando um deles._',
  ].join('\n');
}

export function composeNoDay(name: string, date: string) {
  return [`📭 *${short(name)} · sem produção em ${br(date)}*`, '', '_Pode ter sido um dia sem turno. Quer consultar outro dia?_'].join(
    '\n',
  );
}

export interface Question {
  kind: 'agora' | 'dia' | 'paradas' | 'periodo' | 'comparativo';
  from?: string;
  to?: string;
  dates?: string;
  device?: string;
}

interface Machine {
  id: string;
  name: string;
  dashboard_id: string | null;
}

const produced = (f: DayFacts | null): f is DayFacts => f != null && (f.made > 0 || f.stoppedSeconds > 0);

/** The messages that answer a question about the given machines (already chosen for the person). */
export async function answerQuestion(
  db: Database,
  tenantId: string,
  machines: Machine[],
  question: Question,
  web: string,
  dayFigures: (machine: Machine, date: string) => Promise<(DayFigures & { metric: string }) | null>,
  now = new Date(),
) {
  const today = plantDate(now);
  const messages: string[] = [];
  const kind = question.kind === 'dia' && (question.from ?? today) >= today ? 'agora' : question.kind;
  for (const machine of machines.slice(0, MAX_MESSAGES)) {
    if (kind === 'agora') {
      const briefing = await buildBriefing(db, { tenantId, id: null }, machine.id, now);
      if (!briefing.configured) continue;
      const facts = await gatherDay(db, tenantId, machine, today).catch(() => null);
      messages.push(
        composeNow(
          {
            name: machine.name,
            metric: briefing.metric,
            clock: plantClock(now.toISOString()),
            state: briefing.state.state,
            since: briefing.state.since,
            product: briefing.state.product,
            made: briefing.made,
            target: briefing.target,
            pacePerHour: briefing.pacePerHour,
            utilization: briefing.utilization,
            yesterday: briefing.yesterday,
            shiftStatus: briefing.shiftStatus,
          },
          facts,
        ),
      );
      continue;
    }
    if (kind === 'dia' || kind === 'paradas') {
      const date = question.from ?? today;
      const facts = await gatherDay(db, tenantId, machine, date);
      if (!produced(facts)) {
        messages.push(composeNoDay(machine.name, date));
        continue;
      }
      messages.push(kind === 'dia' ? composeDay(facts, panelLink(web, machine.dashboard_id)) : composeStops(facts, date === today));
      continue;
    }
    const days: string[] =
      kind === 'comparativo'
        ? (question.dates ?? '').split(',').filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today)
        : (() => {
            const list: string[] = [];
            const to = (question.to ?? today) > today ? today : (question.to ?? today);
            for (let day = question.from ?? today; day <= to && list.length < 62; day = addDays(day, 1)) list.push(day);
            return list;
          })();
    // Up to 62 days: the lighter figures, one day at a time so the database is not flooded.
    const facts: Array<DayFigures & { metric: string }> = [];
    for (const day of days) {
      const figures = await dayFigures(machine, day);
      if (figures) facts.push(figures);
    }
    const metric = facts[0]?.metric ?? 'pallets';
    if (kind === 'comparativo') {
      if (facts.length < 2) messages.push(composeNoDay(machine.name, days.find((day) => !facts.some((f) => f.date === day)) ?? days[0]));
      else messages.push(composeComparison(machine.name, metric, facts));
    } else messages.push(composePeriod(machine.name, metric, days[0] ?? today, days.at(-1) ?? today, facts, today));
  }
  return messages;
}
