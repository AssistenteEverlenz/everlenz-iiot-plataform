'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { usePoll, type Device, type Sample, time, value } from '../../../components/data';
export default function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [minutes, setMinutes] = useState(15),
    [tag, setTag] = useState('');
  const device = usePoll<Device>(`/devices/${id}`),
    latest = usePoll<Sample[]>(`/devices/${id}/latest`);
  const numeric = latest.data?.filter((t) => t.data_type === 'number') ?? [];
  const selected = tag || numeric[0]?.tag_id || '';
  // Rounded minute keeps the poll subscription stable while the window advances.
  const from = new Date(Math.floor(Date.now() / 60000) * 60000 - minutes * 60000).toISOString();
  const history = usePoll<Sample[]>(
    `/telemetry?deviceId=${id}&limit=500&from=${encodeURIComponent(from)}${selected ? `&tagId=${selected}` : ''}`,
  );
  const points = [...(history.data ?? [])]
    .reverse()
    .map((s) => ({ ...s, t: new Date(s.timestamp!).getTime() }));
  return (
    <>
      <div className="heading">
        <div>
          <Link className="eyebrow" href="/devices">
            ← DISPOSITIVOS
          </Link>
          <h1>{device.data?.name ?? 'Dispositivo'}</h1>
          <p>
            {device.data?.manufacturer} · {device.data?.model} · {device.data?.adapter_type}
          </p>
          {device.data?.device_code && <span className="code-chip">{device.data.device_code}</span>}
        </div>
        <div className="toolbar-actions">
          <a
            className="secondary-button"
            href={`/api/export/telemetry.csv?deviceId=${id}&limit=10000`}
          >
            Exportar CSV
          </a>
          <Link className="primary-button" href="/dashboards/55555555-5555-4555-8555-555555555555">
            Abrir painel
          </Link>
          <span className={`badge ${device.data?.online ? '' : 'offline'}`}>
            {device.data?.online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>
      {(device.error || latest.error || history.error) && (
        <div className="error-banner">{device.error || latest.error || history.error}</div>
      )}
      <p>Última comunicação: {time(device.data?.last_message_at)}</p>
      <div className="stats section-space">
        {latest.data?.map((s) => (
          <div className="card" key={s.tag_id}>
            <div className="stat-label">{s.key}</div>
            <div className="tag-value">
              {value(s)}{' '}
              <span className="muted" style={{ fontSize: 13 }}>
                {s.unit}
              </span>
            </div>
            <div className="subline">{time(s.timestamp)}</div>
            {s.quality && s.quality !== 'good' && (
              <span className="badge unrecognized">{s.quality}</span>
            )}
          </div>
        ))}
      </div>
      <section className="card">
        <h2>Histórico de telemetria</h2>
        <div className="controls">
          <label>
            Variável
            <select aria-label="Variável" value={selected} onChange={(e) => setTag(e.target.value)}>
              {numeric.map((t) => (
                <option key={t.tag_id} value={t.tag_id}>
                  {t.key} ({t.unit})
                </option>
              ))}
            </select>
          </label>
          <label>
            Período
            <select
              aria-label="Período"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              <option value={15}>Últimos 15 minutos</option>
              <option value={60}>Última hora</option>
              <option value={1440}>Últimas 24 horas</option>
            </select>
          </label>
        </div>
        {points.length ? (
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => new Date(v).toLocaleTimeString('pt-BR')}
                  tick={{ fontSize: 10 }}
                />
                <YAxis width={50} tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                <Tooltip labelFormatter={(v) => new Date(Number(v)).toLocaleString('pt-BR')} />
                <Line
                  type="linear"
                  dataKey="value_number"
                  name={numeric.find((t) => t.tag_id === selected)?.key ?? 'Valor'}
                  stroke="#139b8a"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty">Sem amostras neste período. Inicie o simulador MQTT.</div>
        )}
        <p>
          Até 500 amostras mais recentes da variável no período. Histórico completo disponível pela
          API paginada.
        </p>
      </section>
    </>
  );
}
