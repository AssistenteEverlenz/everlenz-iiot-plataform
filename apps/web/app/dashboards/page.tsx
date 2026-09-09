'use client';
import Link from 'next/link';
import { usePoll, type Dashboard } from '../../components/data';

export default function Dashboards() {
  const dashboards = usePoll<Dashboard[]>('/dashboards');
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">GESTÃO À VISTA</div>
          <h1>Painéis</h1>
          <p>Visões operacionais configuradas para cada fábrica, linha ou equipamento.</p>
        </div>
      </div>
      {dashboards.error && <div className="error-banner">{dashboards.error}</div>}
      <div className="dashboard-list">
        {dashboards.data?.map((dashboard) => (
          <Link
            href={`/dashboards/${dashboard.id}`}
            className="dashboard-list-card"
            key={dashboard.id}
          >
            <div className="dashboard-list-visual">
              <span className="mini-chart" />
              <span />
              <span />
            </div>
            <div>
              <span className="widget-kicker">
                {dashboard.is_default ? 'PAINEL PRINCIPAL' : 'PAINEL'}
              </span>
              <h2>{dashboard.name}</h2>
              <p>
                {dashboard.device_name ?? 'Múltiplos ativos'} · {dashboard.widget_count} indicadores
              </p>
            </div>
            <b>→</b>
          </Link>
        ))}
      </div>
    </>
  );
}
