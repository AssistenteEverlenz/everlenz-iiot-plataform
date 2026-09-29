'use client';

import { useMemo, useState } from 'react';
import { mutate, usePoll } from './data';
import { usePlatform } from './PlatformShell';

/**
 * Wear of the line: the brick weight someone measured, the parts that were replaced, and what
 * the two together say about the die (boquilha) and the auger (caracol).
 *
 * The platform's tonnage is pieces times the recipe's nominal weight, so it can never show that
 * a brick got heavier. Only a person weighing bricks can, and that is the whole point of this
 * window: with a measured weight, a lost rate can be split between the two causes instead of
 * being one number nobody can act on.
 */
type Weight = {
  id: string;
  date: string;
  product: string;
  runningProduct: string | null;
  averageKg: number;
  spreadKg: number | null;
  nominalKg: number | null;
  pieces: number;
  note: string | null;
  author: string | null;
  voided: boolean;
};
type Event = { id: string; date: string; kind: string; note: string | null; author: string | null };
type Wear = {
  product: string | null;
  since: string | null;
  dieChangedOn: string | null;
  augerChangedOn: string | null;
  reference: { week: string; capacity: number; weightKg: number | null } | null;
  weeks: Array<{
    week: string;
    capacity: number;
    weightKg: number | null;
    samples: number;
    rateDrift: number | null;
    dieDrift: number | null;
    augerDrift: number | null;
  }>;
};

const KINDS: Record<string, string> = {
  boquilha: 'Troca de boquilha',
  caracol: 'Troca do caracol',
  outro: 'Outra manutenção',
};

const percent = (value: number | null | undefined) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

const day = (date: string) => date.split('-').reverse().slice(0, 2).join('/');

export function WearModal({
  deviceId,
  deviceName,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const { user } = usePlatform();
  const mayLog = user.role === 'master' || user.canLogMeasurements === true;
  const recipes = usePoll<{ recipes: string[]; running: string | null }>(
    `/devices/${deviceId}/recipes`,
    300000,
  );
  const weights = usePoll<{ weights: Weight[] }>(`/devices/${deviceId}/weights`, 300000);
  const events = usePoll<{ events: Event[] }>(`/devices/${deviceId}/maintenance`, 300000);
  const [product, setProduct] = useState('');
  const wear = usePoll<Wear>(
    `/devices/${deviceId}/wear${product ? `?product=${encodeURIComponent(product)}` : ''}`,
    300000,
  );

  // The recipe running now is the truth at the moment of weighing, so it leads; the list is
  // there for a brick weighed later. Never a free text field: a recipe typed by hand creates a
  // product that exists nowhere and splits the history in two.
  const running = recipes.data?.running ?? '';
  const [chosen, setChosen] = useState('');
  const recipe = chosen || running || recipes.data?.recipes[0] || '';
  const [sample, setSample] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const parsed = useMemo(
    () =>
      sample
        .split(/[\s,;]+/)
        .map((piece) => Number(piece.replace(',', '.')))
        .filter((value) => Number.isFinite(value) && value > 0),
    [sample],
  );
  const average = parsed.length ? parsed.reduce((sum, value) => sum + value, 0) / parsed.length : 0;
  const spread = parsed.length > 1 ? Math.max(...parsed) - Math.min(...parsed) : null;

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (!recipe) throw new Error('Escolha a receita da amostra.');
      if (!parsed.length) throw new Error('Informe o peso de ao menos um tijolo, em quilos.');
      await mutate(`/devices/${deviceId}/weights`, 'POST', {
        product: recipe,
        weights: parsed,
        note: note.trim() || undefined,
      });
      setSample('');
      setNote('');
      await Promise.all([weights.refresh(), wear.refresh()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao lançar o peso.');
    } finally {
      setSaving(false);
    }
  }

  const [eventDate, setEventDate] = useState('');
  const [eventKind, setEventKind] = useState('boquilha');
  async function saveEvent() {
    setError('');
    try {
      if (!eventDate) throw new Error('Informe a data da manutenção.');
      await mutate(`/devices/${deviceId}/maintenance`, 'POST', { date: eventDate, kind: eventKind });
      setEventDate('');
      await Promise.all([events.refresh(), wear.refresh()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao registrar a manutenção.');
    }
  }

  const rows = wear.data?.weeks ?? [];
  const latest = rows.at(-1) ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal wear-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <strong>Desgaste da linha</strong>
            <small>{deviceName}</small>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </header>

        <div className="wear-explain">
          O ritmo cai por dois motivos. Com a boquilha gasta o tijolo pesa mais e a mesma massa
          rende menos peças; com o caracol gasto a maromba entrega menos massa e o tijolo continua
          igual. Pesando o tijolo, dá para saber qual dos dois está acontecendo.
        </div>

        {latest && (
          <div className="wear-verdict">
            <div>
              <span>Capacidade da semana</span>
              <b>{latest.capacity.toLocaleString('pt-BR')}</b>
              <small>peças/h · {percent(latest.rateDrift)} contra a referência</small>
            </div>
            <div>
              <span>Boquilha</span>
              <b>{percent(latest.dieDrift)}</b>
              <small>{latest.weightKg ? `tijolo a ${latest.weightKg.toFixed(3)} kg` : 'sem peso lançado'}</small>
            </div>
            <div>
              <span>Caracol</span>
              <b>{percent(latest.augerDrift)}</b>
              <small>{latest.augerDrift == null ? 'precisa do peso' : 'o que a boquilha não explica'}</small>
            </div>
          </div>
        )}

        {mayLog && (
          <div className="wear-form">
            <div className="wear-section-title">Peso do tijolo hoje</div>
            <div className="wear-fields">
              <label>
                Receita
                <select value={recipe} onChange={(event) => setChosen(event.target.value)}>
                  {running && <option value={running}>{running} (rodando agora)</option>}
                  {(recipes.data?.recipes ?? [])
                    .filter((item) => item !== running)
                    .map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                </select>
              </label>
              <label className="wear-sample">
                Pesos, em quilos
                <input
                  value={sample}
                  onChange={(event) => setSample(event.target.value)}
                  placeholder="3,02  2,98  3,05"
                  inputMode="decimal"
                />
              </label>
              <label>
                Observação
                <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} />
              </label>
            </div>
            <div className="wear-sample-hint">
              {parsed.length
                ? `${parsed.length} tijolo(s) · média ${average.toFixed(3)} kg${spread != null ? ` · diferença entre o maior e o menor ${spread.toFixed(3)} kg` : ''}`
                : 'Pese de três a cinco tijolos: a diferença entre eles denuncia a boquilha antes da média se mover.'}
            </div>
            <div className="wear-actions">
              <button className="primary" disabled={saving || !parsed.length} onClick={() => void save()}>
                {saving ? 'Lançando…' : 'Lançar peso'}
              </button>
            </div>

            <div className="wear-section-title">Registrar uma troca</div>
            <div className="wear-fields">
              <label>
                Data
                <input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} />
              </label>
              <label>
                O que foi trocado
                <select value={eventKind} onChange={(event) => setEventKind(event.target.value)}>
                  {Object.entries(KINDS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="wear-actions">
                <button disabled={!eventDate} onClick={() => void saveEvent()}>
                  Registrar
                </button>
              </div>
            </div>
            <div className="wear-sample-hint">
              Cada curva de desgaste é lida a partir da última troca daquela peça.
            </div>
          </div>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="wear-section-title">
          Semana a semana{wear.data?.product ? ` · ${wear.data.product}` : ''}
          {wear.data?.since && <small> desde a troca de {day(wear.data.since)}</small>}
        </div>
        {rows.length ? (
          <table className="wear-table">
            <thead>
              <tr>
                <th>Semana</th>
                <th className="n">Capacidade</th>
                <th className="n">Ritmo</th>
                <th className="n">Peso</th>
                <th className="n">Boquilha</th>
                <th className="n">Caracol</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.week}>
                  <td>{day(row.week)}</td>
                  <td className="n">{row.capacity.toLocaleString('pt-BR')}</td>
                  <td className="n">{percent(row.rateDrift)}</td>
                  <td className="n">{row.weightKg ? `${row.weightKg.toFixed(3)} kg` : '—'}</td>
                  <td className="n">{percent(row.dieDrift)}</td>
                  <td className="n">{percent(row.augerDrift)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="wear-empty">
            Ainda sem semanas completas para comparar. A capacidade é medida só em trechos em que
            a linha produziu os cinco minutos inteiros.
          </div>
        )}

        <div className="wear-section-title">Últimos lançamentos</div>
        {weights.data?.weights.length ? (
          <table className="wear-table">
            <thead>
              <tr>
                <th>Dia</th>
                <th>Receita</th>
                <th className="n">Média</th>
                <th className="n">Diferença</th>
                <th>Quem lançou</th>
              </tr>
            </thead>
            <tbody>
              {weights.data.weights.slice(0, 12).map((row) => (
                <tr key={row.id} className={row.voided ? 'voided' : ''}>
                  <td>{day(row.date)}</td>
                  <td>{row.product}</td>
                  <td className="n">{row.averageKg.toFixed(3)} kg</td>
                  <td className="n">{row.spreadKg == null ? '—' : `${row.spreadKg.toFixed(3)} kg`}</td>
                  <td>{row.author ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="wear-empty">Nenhum peso lançado ainda.</div>
        )}

        {Boolean(events.data?.events.length) && (
          <>
            <div className="wear-section-title">Trocas registradas</div>
            <ul className="wear-events">
              {events.data?.events.map((item) => (
                <li key={item.id}>
                  <b>{day(item.date)}</b> {KINDS[item.kind] ?? item.kind}
                  {item.author && <small> · {item.author}</small>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
