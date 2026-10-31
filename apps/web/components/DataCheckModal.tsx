'use client';

import { useState } from 'react';
import { mutate, usePoll } from './data';
import { confirmar } from './Dialogs';
import { formatNumber } from './ShiftBoard';

// "Verificar dados": the production check (API production-audit.ts) seen and driven by the
// master. The platform checks itself every four hours; here anyone with the master role can run
// it over any period, read in plain words what was found, and correct or accept each point.
// Every correction keeps the values before and after.

type Kind = 'refused_step' | 'recount' | 'jump' | 'late_burst' | 'suspicious' | 'report_mismatch';
type Counter = 'pieces' | 'pallets' | 'tons' | 'all';
type Totals = { pieces: number; pallets: number; tons: number };
interface Anomaly {
  id: string;
  kind: Kind;
  counter: Counter;
  window_start: string;
  production_date: string;
  amount: number;
  occurrences: number;
  status: 'open' | 'fixed' | 'accepted';
  details: Record<string, unknown>;
  resolved_at: string | null;
  resolution: { by?: string; action?: string; note?: string } | null;
}

const PERIODS = [
  ['7', 'Últimos 7 dias'],
  ['30', 'Últimos 30 dias'],
  ['62', 'Últimos 62 dias'],
] as const;
const UNIT: Record<Counter, string> = { pieces: 'peças', pallets: 'paletes', tons: 't', all: '' };

function plantToday() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function minusDays(date: string, days: number) {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}
const brDate = (date: string) => date.split('-').reverse().slice(0, 2).join('/');
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
const minutes = (value: unknown) => {
  const total = Number(value ?? 0);
  return total >= 90 ? `${formatNumber(total / 60, 1)} h` : `${formatNumber(total)} min`;
};
/** "8.094 peças · 40 paletes · 29,4 t", leaving out what the line does not count. */
function totals(value: unknown) {
  const item = (value ?? {}) as Partial<Totals>;
  return (
    [
      item.pieces ? `${formatNumber(item.pieces)} peças` : null,
      item.pallets ? `${formatNumber(item.pallets)} paletes` : null,
      item.tons ? `${formatNumber(item.tons, 1)} t` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'nada'
  );
}

/** What a finding means, in words anyone at the plant can follow, and what correcting does. */
function explain(item: Anomaly) {
  const d = item.details;
  const unit = UNIT[item.counter];
  switch (item.kind) {
    case 'refused_step':
      return {
        title: 'A trava segurou um salto do contador',
        text: `O contador de ${unit} pulou de ${formatNumber(Number(d.previous ?? 0))} para ${formatNumber(Number(d.reading ?? 0))}${item.occurrences > 1 ? ` (${item.occurrences} vezes nestes 5 minutos)` : ''}. Nenhuma máquina produz tanto tão rápido, então a leitura não foi contada. Quando acontece várias vezes seguidas, quase sempre é uma segunda IHM usando o mesmo login.`,
        fix: null,
      };
    case 'recount':
      return {
        title: 'O dia foi contado errado',
        text: `Recontando as leituras do dia, com a trava, dá ${totals(d.recount)}. O que está salvo é ${totals(d.stored)}.${Number(d.refused) ? ` A trava recusou ${d.refused} salto(s) nesse dia.` : ''}`,
        fix: `Contar o dia de novo: fica ${totals(d.recount)}.`,
      };
    case 'jump':
      return {
        title: `Salto impossível no contador de ${unit}`,
        text: `Entraram ${formatNumber(Number(d.value))} ${unit} em 5 minutos. No tempo que teve, a linha faria no máximo ${formatNumber(Number(d.limit))}; no normal ela faz ${formatNumber(Number(d.typical))} a cada 5 minutos. Costuma ser contador editado na IHM ou leitura errada.`,
        fix: `Trocar por ${formatNumber(Number(d.proposed))} ${unit}, o normal da linha.`,
      };
    case 'suspicious':
      return {
        title: `Muito acima do normal (${unit})`,
        text: `Entraram ${formatNumber(Number(d.value))} ${unit} em 5 minutos, quando o mais alto normal da linha é cerca de ${formatNumber(Number(d.busiest))}. É possível, mas vale conferir com a fábrica.`,
        fix: `Trocar por ${formatNumber(Number(d.proposed))} ${unit}, o normal da linha.`,
      };
    case 'late_burst': {
      const dates = (d.targetDates as string[] | undefined) ?? [];
      return {
        title: 'Produção chegou atrasada, toda de uma vez',
        text: `A IHM ficou ${minutes(d.gapMinutes)} sem comunicar (desde ${clock(String(d.offlineFrom))}). O CLP continuou contando, e quando ela voltou entraram ${totals(d.value)} de uma vez. A quantidade está certa; o horário, não.`,
        fix: Number(d.targets)
          ? `Distribuir pelo horário de turno em que ela ficou fora${dates.length ? ` (${dates.map(brDate).join(' e ')})` : ''}.`
          : null,
        note: Number(d.targets)
          ? null
          : 'O intervalo ficou fora do horário de turno: não há para onde levar. Se a quantidade está certa, aceite.',
      };
    }
    case 'report_mismatch':
      return {
        title: 'O relatório do dia não bate com a contagem',
        text: `Os turnos do dia somam ${totals(d.reported)}, mas a contagem da linha é ${totals(d.buckets)}.`,
        fix: 'Refazer os turnos do dia a partir da contagem.',
      };
  }
}

export function DataCheckModal({
  deviceId,
  deviceName,
  onClose,
  onChanged,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
  /** The counts changed: the page reloads its history. */
  onChanged: () => void;
}) {
  const [days, setDays] = useState<(typeof PERIODS)[number][0]>('30');
  const to = plantToday();
  const from = minusDays(to, Number(days) - 1);
  const listed = usePoll<Anomaly[]>(
    `/devices/${deviceId}/production-anomalies?from=${from}&to=${to}`,
    600000,
  );
  const [ran, setRan] = useState<{ found: number; fixed: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const items = listed.data ?? [];
  const pending = items.filter((item) => item.status === 'open' && item.kind !== 'refused_step');
  const held = items.filter((item) => item.status === 'open' && item.kind === 'refused_step');
  const done = items.filter((item) => item.status !== 'open');

  async function run() {
    setBusy('run');
    setError('');
    try {
      const result = await mutate<{ found: number; fixed: number }>(
        `/devices/${deviceId}/production-audit`,
        'POST',
        { from, to },
      );
      setRan(result);
      await listed.refresh();
      if (result.fixed) onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível verificar.');
    } finally {
      setBusy(null);
    }
  }

  async function resolve(item: Anomaly, action: 'fix' | 'accept') {
    const meaning = explain(item);
    if (
      action === 'fix' &&
      !(await confirmar({
        titulo: 'Corrigir os dados?',
        texto: `${meaning.fix} Os valores de antes ficam guardados no histórico de correções.`,
        confirmar: 'Corrigir',
      }))
    )
      return;
    setBusy(item.id);
    setError('');
    try {
      await mutate(`/production-anomalies/${item.id}/resolve`, 'POST', { action });
      await listed.refresh();
      if (action === 'fix') onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível concluir.');
    } finally {
      setBusy(null);
    }
  }

  const row = (item: Anomaly, actions: 'decide' | 'ack' | 'none') => {
    const meaning = explain(item);
    return (
      <div key={item.id} className={`data-check-item ${item.kind}`}>
        <div className="data-check-when">
          <b>{brDate(item.production_date)}</b>
          {!['recount', 'report_mismatch'].includes(item.kind) && (
            <span>{clock(item.window_start)}</span>
          )}
        </div>
        <div className="data-check-body">
          <strong>{meaning.title}</strong>
          <p>{meaning.text}</p>
          {actions === 'decide' && meaning.fix && (
            <p className="data-check-fix">
              <span>Correção:</span> {meaning.fix}
            </p>
          )}
          {actions === 'decide' && meaning.note && <p className="data-check-fix">{meaning.note}</p>}
          {actions === 'none' && (
            <p className="data-check-fix">
              {item.status === 'fixed' ? 'Corrigido' : 'Aceito como está'}
              {item.resolution?.by ? ` por ${item.resolution.by}` : ''}
              {item.resolved_at
                ? ` em ${new Date(item.resolved_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                : ''}
              {item.resolution?.note ? ` (${item.resolution.note})` : ''}.
            </p>
          )}
        </div>
        {actions !== 'none' && (
          <div className="data-check-actions">
            {actions === 'decide' && meaning.fix && (
              <button
                type="button"
                className="primary-button"
                disabled={busy !== null}
                onClick={() => void resolve(item, 'fix')}
              >
                {busy === item.id && <span className="button-spinner" />}
                Corrigir
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void resolve(item, 'accept')}
              title={
                actions === 'ack'
                  ? 'Some da lista; a leitura continua não contada'
                  : 'Os dados ficam como estão'
              }
            >
              {actions === 'ack' ? 'Entendi' : 'Está certo'}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal-card data-check-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">VERIFICAR DADOS</div>
            <h2>{deviceName}</h2>
          </div>
          <button type="button" className="icon-button" disabled={!!busy} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="shifts-help">
          A plataforma confere a própria contagem a cada 4 horas: reconta as leituras dos últimos
          dias, procura saltos que nenhuma máquina faria, produção que chegou atrasada e relatórios
          que não batem. O que é certo ela corrige sozinha; o resto fica aqui para você decidir.
        </p>
        <div className="data-check-bar">
          <label className="field">
            Período
            <select value={days} onChange={(event) => setDays(event.target.value as typeof days)}>
              {PERIODS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null}
            onClick={() => void run()}
          >
            {busy === 'run' && <span className="button-spinner" />}
            {busy === 'run' ? 'Verificando…' : 'Verificar agora'}
          </button>
        </div>

        {!listed.data ? (
          <p>{listed.error ?? 'Carregando…'}</p>
        ) : (
          <>
            {ran && (
              <div className={`shift-health ${pending.length ? 'warn' : 'good'}`}>
                Verificação concluída:{' '}
                {ran.found ? `${ran.found} ponto(s) encontrado(s)` : 'nada fora do lugar'}
                {ran.fixed ? `, ${ran.fixed} corrigido(s) automaticamente` : ''}.
              </div>
            )}
            {!ran && !pending.length && !held.length && (
              <div className="shift-health good">
                Nada para decidir neste período. A contagem confere.
              </div>
            )}
            {pending.length > 0 && (
              <section className="data-check-section">
                <h3>Precisa da sua decisão ({pending.length})</h3>
                {pending.map((item) => row(item, 'decide'))}
              </section>
            )}
            {held.length > 0 && (
              <section className="data-check-section">
                <h3>A trava segurou ({held.length})</h3>
                {held.map((item) => row(item, 'ack'))}
              </section>
            )}
            {done.length > 0 && (
              <section className="data-check-section">
                <button
                  type="button"
                  className="data-check-toggle"
                  onClick={() => setShowDone(!showDone)}
                >
                  {showDone ? '▾' : '▸'} Já tratados ({done.length})
                </button>
                {showDone && done.map((item) => row(item, 'none'))}
              </section>
            )}
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={!!busy} onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
