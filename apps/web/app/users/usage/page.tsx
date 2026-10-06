'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePoll } from '../../../components/data';
import {
  DailyUsageChart,
  duration,
  PeriodPills,
  UserUsageModal,
  when,
  type UsageOverview,
  type UsageRow,
} from '../../../components/UsageViews';
import { ModalPortal } from '../../../components/ModalPortal';

// Who uses the platform and how much, for the master: the three leaders, the day-by-day use of
// everyone together, and a ranking that sorts by any column. A row opens that person's detail.

type SortKey = 'activeMinutes' | 'openMinutes' | 'visits' | 'activeDays' | 'logins' | 'lastSeenAt';
const COLUMNS: Array<[SortKey, string]> = [
  ['activeMinutes', 'Tempo em uso'],
  ['openMinutes', 'Tempo aberta'],
  ['visits', 'Visitas'],
  ['activeDays', 'Dias com acesso'],
  ['logins', 'Logins'],
  ['lastSeenAt', 'Visto por último'],
];

function leader(rows: UsageRow[], key: 'activeMinutes' | 'visits' | 'activeDays') {
  const best = [...rows].sort((a, b) => b[key] - a[key])[0];
  return best && best[key] > 0 ? best : null;
}

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState<SortKey>('activeMinutes');
  const [hideMaster, setHideMaster] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const overview = usePoll<UsageOverview>(`/usage/overview?days=${days}`, 120000);
  const rows = useMemo(() => {
    const list = (overview.data?.users ?? []).filter((row) => !hideMaster || row.role !== 'master');
    return [...list].sort((a, b) =>
      sort === 'lastSeenAt'
        ? (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')
        : b[sort] - a[sort],
    );
  }, [overview.data, sort, hideMaster]);
  const using = rows.filter((row) => row.openMinutes > 0);
  const activeTotal = rows.reduce((sum, row) => sum + row.activeMinutes, 0);
  const visitsTotal = rows.reduce((sum, row) => sum + row.visits, 0);
  const most = leader(rows, 'activeMinutes');
  const often = leader(rows, 'visits');
  const steady = leader(rows, 'activeDays');

  return (
    <div className="usage-page">
      <div className="heading">
        <div>
          <div className="eyebrow">ADMINISTRAÇÃO MASTER</div>
          <h1>Uso da plataforma</h1>
          <p>
            Quem acessa, por quanto tempo e o que vê. Conta o tempo com a plataforma na tela; TVs
            ficam à parte. <Link href="/users">Voltar para usuários</Link>
          </p>
        </div>
        <PeriodPills days={days} onDays={setDays} />
      </div>
      {overview.error && <div className="error-banner">{overview.error}</div>}

      <section className="user-summary-grid usage-summary">
        <div className="card usage-tile">
          <span>PESSOAS QUE USARAM</span>
          <strong>{overview.data ? using.length : '—'}</strong>
          <small>de {rows.length} usuários</small>
        </div>
        <div className="card usage-tile">
          <span>TEMPO EM USO</span>
          <strong>{overview.data ? duration(activeTotal) : '—'}</strong>
          <small>somando todos, com interação</small>
        </div>
        <div className="card usage-tile">
          <span>VISITAS</span>
          <strong>{overview.data ? visitsTotal : '—'}</strong>
          <small>
            {using.length ? `${duration(activeTotal / using.length)} em uso por pessoa` : 'sem uso'}
          </small>
        </div>
      </section>

      <section className="usage-leaders">
        {(
          [
            ['Quem fica mais tempo', most, most ? duration(most.activeMinutes) : ''],
            ['Quem mais acessa', often, often ? `${often.visits} visitas` : ''],
            ['Mais dias com acesso', steady, steady ? `${steady.activeDays} dias` : ''],
          ] as const
        ).map(([title, row, figure]) => (
          <button
            key={title}
            type="button"
            className="card usage-leader"
            disabled={!row}
            onClick={() => row && setOpened(row.id)}
          >
            <span>{title}</span>
            <strong>{row?.name ?? '—'}</strong>
            <small>{row ? figure : 'sem uso no período'}</small>
          </button>
        ))}
      </section>

      <section className="card usage-daily">
        <div className="shift-section-title">Tempo em uso por dia · todos os usuários</div>
        {overview.data?.daily.length ? (
          <DailyUsageChart data={overview.data.daily} days={days} label="em uso" />
        ) : (
          <p className="shifts-help">
            Nenhum uso registrado ainda. O registro começou na implantação desta tela.
          </p>
        )}
      </section>

      <section className="card table-scroll">
        <div className="usage-table-head">
          <div className="shift-section-title">Ranking · clique no nome para ver o detalhe</div>
          <label className="usage-check">
            <input
              type="checkbox"
              checked={hideMaster}
              onChange={(event) => setHideMaster(event.target.checked)}
            />
            Ocultar contas master
          </label>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Usuário</th>
              {COLUMNS.map(([key, label]) => (
                <th key={key} className="n">
                  <button
                    type="button"
                    className={`usage-sort${sort === key ? ' active' : ''}`}
                    onClick={() => setSort(key)}
                  >
                    {label}
                    {sort === key ? ' ↓' : ''}
                  </button>
                </th>
              ))}
              <th>Mais vê</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} className="usage-row" onClick={() => setOpened(row.id)}>
                <td>{row.openMinutes ? `${index + 1}º` : '—'}</td>
                <td>
                  <strong>{row.name}</strong>
                  <small>
                    {row.email}
                    {row.role === 'master' ? ' · master' : ''}
                    {row.status !== 'active' ? ' · desativado' : ''}
                  </small>
                </td>
                <td className="n">{duration(row.activeMinutes)}</td>
                <td className="n">
                  {duration(row.openMinutes)}
                  {row.tvMinutes > 0 && <small>TV {duration(row.tvMinutes)}</small>}
                </td>
                <td className="n">{row.visits || '—'}</td>
                <td className="n">{row.activeDays || '—'}</td>
                <td className="n">{row.logins || '—'}</td>
                <td className="n">{when(row.lastSeenAt ?? row.lastLoginAt)}</td>
                <td>{row.topPage ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {opened && (
        <ModalPortal>
          <UserUsageModal
            userId={opened}
            days={days}
            onDays={setDays}
            onClose={() => setOpened(null)}
          />
        </ModalPortal>
      )}
    </div>
  );
}
