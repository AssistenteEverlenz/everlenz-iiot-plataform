'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { time, usePoll, type Dashboard } from '../../components/data';

type StatusFilter = 'all' | 'online' | 'offline' | 'deactivated';

export default function Dashboards() {
  const dashboards = usePoll<Dashboard[]>('/dashboards');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const filtered = useMemo(
    () =>
      (dashboards.data ?? []).filter((dashboard) => {
        const matchesStatus =
          status === 'all' ||
          (status === 'online' && dashboard.device_online && !dashboard.device_deactivated) ||
          (status === 'offline' && !dashboard.device_online && !dashboard.device_deactivated) ||
          (status === 'deactivated' && dashboard.device_deactivated);
        const text = `${dashboard.site_name ?? ''} ${dashboard.site_reference ?? ''} ${dashboard.device_name ?? ''} ${dashboard.device_code ?? ''} ${dashboard.name}`.toLowerCase();
        return matchesStatus && text.includes(search.trim().toLowerCase());
      }),
    [dashboards.data, search, status],
  );
  const count = (filter: StatusFilter) =>
    (dashboards.data ?? []).filter((dashboard) =>
      filter === 'all'
        ? true
        : filter === 'online'
          ? dashboard.device_online && !dashboard.device_deactivated
          : filter === 'offline'
            ? !dashboard.device_online && !dashboard.device_deactivated
            : dashboard.device_deactivated,
    ).length;

  return (
    <>
      <div className="heading">
        <div><div className="eyebrow">GESTÃO À VISTA</div><h1>Painéis</h1><p>Um painel é criado automaticamente para cada equipamento.</p></div>
      </div>
      <div className="dashboard-filters">
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cliente, equipamento ou código…" />
        <div className="status-filter-buttons">
          {([['all','Todos'],['online','Online'],['offline','Offline'],['deactivated','Desativados']] as const).map(([value,label]) => <button key={value} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{label}<b>{count(value)}</b></button>)}
        </div>
      </div>
      {dashboards.error && <div className="error-banner">{dashboards.error}</div>}
      <div className="dashboard-list">
        {filtered.map((dashboard) => (
          <Link href={`/dashboards/${dashboard.id}`} className={`dashboard-list-card ${dashboard.device_deactivated ? 'deactivated' : ''}`} key={dashboard.id}>
            <div className="dashboard-list-visual"><span className="mini-chart"/><span/><span/></div>
            <div className="dashboard-card-copy">
              <span className="widget-kicker">{dashboard.site_name ?? 'CLIENTE'} · {dashboard.site_reference ?? 'SEM REFERÊNCIA'}</span>
              <h2>{dashboard.name}</h2>
              <p><b>{dashboard.device_name ?? 'Múltiplos ativos'}</b> <span className="code-chip">{dashboard.device_code}</span></p>
              <small>Último sinal: {time(dashboard.last_message_at)} · {dashboard.widget_count ?? 0} indicadores</small>
            </div>
            <span className={`dashboard-status ${dashboard.device_deactivated ? 'deactivated' : dashboard.device_online ? 'online' : 'offline'}`}>{dashboard.device_deactivated ? 'Desativado' : dashboard.device_online ? 'Online' : 'Offline'}</span>
            <b>→</b>
          </Link>
        ))}
        {dashboards.data && !filtered.length && <div className="empty">Nenhum painel corresponde aos filtros selecionados.</div>}
      </div>
    </>
  );
}
