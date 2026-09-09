'use client';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePlatform } from './PlatformShell';
import {
  mutate,
  time,
  usePoll,
  value,
  type Dashboard,
  type DashboardWidget,
  type Device,
  type Sample,
  type Signal,
} from './data';

interface Statistic {
  tag_id: string;
  key: string;
  name: string;
  unit: string | null;
  samples: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  trend_per_second: number | null;
}

function number(value: number | null | undefined, decimals = 1) {
  return value == null ? '—' : value.toLocaleString('pt-BR', { maximumFractionDigits: decimals });
}

function Widget({
  widget,
  latest,
  history,
  statistics,
  editing,
  remove,
}: {
  widget: DashboardWidget;
  latest?: Sample;
  history: Sample[];
  statistics?: Statistic;
  editing: boolean;
  remove: () => void;
}) {
  const color = widget.config.color ?? '#12b8a6';
  const numeric = latest?.value_number ?? null;
  const points = history
    .filter((sample) => sample.tag_id === widget.tag_id && sample.value_number != null)
    .reverse()
    .map((sample) => ({
      timestamp: new Date(sample.timestamp!).getTime(),
      value: sample.value_number,
    }));
  const min = widget.config.min ?? 0;
  const max = widget.config.max ?? 100;
  const progress =
    numeric == null ? 0 : Math.max(0, Math.min(100, ((numeric - min) / (max - min || 1)) * 100));
  return (
    <article
      className={`dashboard-widget widget-${widget.width}`}
      style={{ '--accent': color } as React.CSSProperties}
    >
      <div className="widget-head">
        <div>
          <span className="widget-kicker">{widget.widget_type.toUpperCase()}</span>
          <h2>{widget.title}</h2>
        </div>
        {editing && (
          <button className="icon-button danger-button" title="Remover" onClick={remove}>
            ×
          </button>
        )}
      </div>
      {widget.widget_type === 'line' &&
        (points.length ? (
          <div className="widget-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points}>
                <defs>
                  <linearGradient id={`fill-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#20313a" strokeDasharray="2 6" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(item) =>
                    new Date(item).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  }
                  tick={{ fontSize: 10, fill: '#78909a' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#78909a' }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip
                  labelFormatter={(item) => new Date(Number(item)).toLocaleString('pt-BR')}
                  formatter={(item) => [
                    `${number(Number(item), 2)} ${widget.unit ?? ''}`,
                    widget.title,
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2.5}
                  fill={`url(#fill-${widget.id})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="widget-empty">Aguardando histórico</div>
        ))}
      {widget.widget_type === 'gauge' && (
        <div className="gauge-wrap">
          <div
            className="gauge"
            style={{
              background: `conic-gradient(${color} ${progress * 2.7}deg,#e8eef0 0deg 270deg,transparent 270deg)`,
            }}
          >
            <div>
              <strong>{number(numeric, widget.config.decimals ?? 1)}</strong>
              <span>{widget.unit}</span>
            </div>
          </div>
          <div className="gauge-scale">
            <span>{min}</span>
            <span>{max}</span>
          </div>
        </div>
      )}
      {widget.widget_type === 'status' && (
        <div className={`machine-status ${latest?.value_boolean ? 'running' : ''}`}>
          <span className="status-orb" />
          <div>
            <strong>{latest?.value_boolean ? 'Em operação' : 'Parada'}</strong>
            <small>{time(latest?.timestamp)}</small>
          </div>
        </div>
      )}
      {widget.widget_type === 'value' && (
        <>
          <div className="hero-value">
            {latest ? value(latest) : '—'}
            <span>{widget.unit}</span>
          </div>
          <div className="spark-note">Atualizado {time(latest?.timestamp)}</div>
        </>
      )}
      {widget.widget_type === 'production' && (
        <>
          <div className="hero-value">
            {number(statistics?.average)}
            <span>{widget.unit} média</span>
          </div>
          <div className="three-metrics">
            <span>
              <b>{number(statistics?.minimum)}</b>mínimo
            </span>
            <span>
              <b>{number(statistics?.maximum)}</b>pico
            </span>
            <span>
              <b>{statistics?.samples ?? 0}</b>amostras
            </span>
          </div>
        </>
      )}
      {widget.widget_type === 'oee' && (
        <div className="model-placeholder">
          <strong>OEE pronto para configurar</strong>
          <span>Associe contagem total, peças boas, rejeitos, tempo planejado e ciclo ideal.</span>
        </div>
      )}
      {widget.widget_type === 'pareto' && (
        <div className="model-placeholder">
          <strong>Pareto de perdas</strong>
          <span>O gráfico surgirá quando motivos e duração das paradas forem coletados.</span>
        </div>
      )}
    </article>
  );
}

export function DashboardCanvas({ id }: { id: string }) {
  const { user } = usePlatform();
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 2000);
  const refreshMs = dashboard.data?.refresh_ms ?? 2000;
  const deviceId = dashboard.data?.device_id ?? '';
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : '/devices/missing', refreshMs);
  const latest = usePoll<Sample[]>(
    deviceId ? `/devices/${deviceId}/latest` : '/devices/missing/latest',
    refreshMs,
  );
  const signals = usePoll<Signal[]>(
    deviceId ? `/devices/${deviceId}/signals` : '/devices/missing/signals',
    5000,
  );
  const statistics = usePoll<Statistic[]>(
    deviceId ? `/devices/${deviceId}/statistics?hours=24` : '/devices/missing/statistics',
    10000,
  );
  const windowMinutes = dashboard.data?.time_window_minutes ?? 60;
  const from = new Date(
    Math.floor(Date.now() / 60000) * 60000 - windowMinutes * 60000,
  ).toISOString();
  const history = usePoll<Sample[]>(
    deviceId
      ? `/telemetry?deviceId=${deviceId}&from=${encodeURIComponent(from)}&limit=2000`
      : '/telemetry?deviceId=missing',
    Math.max(refreshMs, 5000),
  );
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tv, setTv] = useState(false);
  const [error, setError] = useState('');
  const [signalId, setSignalId] = useState('');
  const [widgetType, setWidgetType] = useState<DashboardWidget['widget_type']>('value');
  const [title, setTitle] = useState('');
  const [color, setColor] = useState('#12b8a6');
  const [width, setWidth] = useState<DashboardWidget['width']>('small');
  const [minimum, setMinimum] = useState(0);
  const [maximum, setMaximum] = useState(100);
  const widgets = dashboard.data?.widgets ?? [];
  const selectedSignal = signals.data?.find(
    (signal) => signal.id === signalId || signal.tag_id === signalId,
  );
  const byTag = useMemo(
    () => new Map((latest.data ?? []).map((sample) => [sample.tag_id, sample])),
    [latest.data],
  );
  async function addWidget(event: React.FormEvent) {
    event.preventDefault();
    if (!dashboard.data || !deviceId) return;
    setError('');
    try {
      let tagId = selectedSignal?.tag_id ?? null;
      if (selectedSignal && !tagId) {
        const tag = await mutate<{ id: string }>(`/devices/${deviceId}/tags`, 'POST', {
          key: selectedSignal.key,
          name: title || selectedSignal.key,
          dataType: selectedSignal.data_type,
          unit: selectedSignal.unit,
          scaleMultiplier: 1,
          scaleOffset: 0,
        });
        tagId = tag.id;
      }
      await mutate(`/dashboards/${id}/widgets`, 'POST', {
        deviceId,
        tagId,
        widgetType,
        title:
          title ||
          selectedSignal?.name ||
          selectedSignal?.key ||
          (widgetType === 'oee' ? 'OEE' : 'Pareto de perdas'),
        width,
        config: { color, min: minimum, max: maximum },
      });
      setAdding(false);
      await Promise.all([dashboard.refresh(), signals.refresh()]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Não foi possível adicionar o indicador.',
      );
    }
  }
  async function updateRefresh(refresh: number) {
    try {
      await mutate(`/dashboards/${id}`, 'PATCH', { refreshMs: refresh });
      await dashboard.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar');
    }
  }
  return (
    <div className={tv ? 'tv-shell' : ''}>
      <div className="dashboard-toolbar">
        <div>
          <div className="eyebrow">SALA DE CONTROLE · TEMPO REAL</div>
          <h1>{dashboard.data?.name ?? 'Painel industrial'}</h1>
          <p>
            {device.data?.name} <span className="code-chip">{device.data?.device_code}</span>
          </p>
        </div>
        <div className="toolbar-actions">
          <span className={`connection-state ${device.data?.online ? 'online' : ''}`}>
            <span />
            {device.data?.online ? 'Online' : 'Offline'}
          </span>
          <button onClick={() => window.print()}>Exportar PDF</button>
          <button onClick={() => setTv(!tv)}>{tv ? 'Sair da TV' : 'Modo TV'}</button>
          {user.role === 'master' && (
            <button className="primary-button" onClick={() => setEditing(!editing)}>
              {editing ? 'Concluir' : 'Personalizar'}
            </button>
          )}
        </div>
      </div>
      {editing && user.role === 'master' && (
        <div className="editor-bar">
          <button className="add-widget-button" onClick={() => setAdding(true)}>
            ＋ Adicionar indicador
          </button>
          <label>
            Atualização
            <select
              value={refreshMs}
              onChange={(event) => void updateRefresh(Number(event.target.value))}
            >
              <option value={1000}>1 segundo</option>
              <option value={2000}>2 segundos</option>
              <option value={5000}>5 segundos</option>
              <option value={10000}>10 segundos</option>
            </select>
          </label>
          <span>Arranjo responsivo · alterações salvas no painel</span>
        </div>
      )}
      {(error || dashboard.error || latest.error) && (
        <div className="error-banner">{error || dashboard.error || latest.error}</div>
      )}
      <div className="dashboard-meta">
        <span>
          <b>Janela</b> últimos{' '}
          {windowMinutes >= 60 ? `${windowMinutes / 60} h` : `${windowMinutes} min`}
        </span>
        <span>
          <b>Atualização</b> {refreshMs / 1000} s
        </span>
        <span>
          <b>Último sinal</b> {time(device.data?.last_message_at)}
        </span>
      </div>
      <section className="widget-grid">
        {widgets.map((widget) => (
          <Widget
            key={widget.id}
            widget={widget}
            latest={widget.tag_id ? byTag.get(widget.tag_id) : undefined}
            history={history.data ?? []}
            statistics={statistics.data?.find((item) => item.tag_id === widget.tag_id)}
            editing={editing}
            remove={() =>
              void mutate(`/dashboards/${id}/widgets/${widget.id}`, 'DELETE')
                .then(() => dashboard.refresh())
                .catch((reason: Error) => setError(reason.message))
            }
          />
        ))}
        {!widgets.length && (
          <button className="empty-dashboard" onClick={() => setAdding(true)}>
            ＋<strong>Monte a primeira visão da operação</strong>
            <span>Escolha uma variável que já chegou pelo MQTT.</span>
          </button>
        )}
      </section>
      <footer className="dashboard-footer">
        <span>EVERLENZ INDUSTRIAL INTELLIGENCE</span>
        <span>Dados recebidos via MQTT · atualização automática</span>
      </footer>
      {adding && (
        <div className="modal-backdrop" onMouseDown={() => setAdding(false)}>
          <form
            className="modal-card"
            onSubmit={addWidget}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <div className="eyebrow">BIBLIOTECA DE INDICADORES</div>
                <h2>Adicionar ao painel</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setAdding(false)}>
                ×
              </button>
            </div>
            <p>As variáveis abaixo foram descobertas nas mensagens reais deste equipamento.</p>
            <div className="form-grid">
              <label className="field full-field">
                Variável
                <select
                  value={signalId}
                  onChange={(event) => {
                    const next = signals.data?.find(
                      (signal) =>
                        signal.id === event.target.value || signal.tag_id === event.target.value,
                    );
                    setSignalId(event.target.value);
                    setTitle(next?.name || next?.key || '');
                  }}
                >
                  <option value="">Indicador calculado ou selecione uma variável…</option>
                  {signals.data?.map((signal) => (
                    <option key={signal.id} value={signal.id}>
                      {signal.key} · {signal.data_type}
                      {signal.configured ? ' · configurada' : ' · descoberta agora'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Visualização
                <select
                  value={widgetType}
                  onChange={(event) =>
                    setWidgetType(event.target.value as DashboardWidget['widget_type'])
                  }
                >
                  <option value="value">Valor em destaque</option>
                  <option value="line">Linha de tendência</option>
                  <option value="gauge">Medidor</option>
                  <option value="status">Estado da máquina</option>
                  <option value="production">Produção: média/mín./máx.</option>
                  <option value="oee">OEE</option>
                  <option value="pareto">Pareto de perdas</option>
                </select>
              </label>
              <label className="field">
                Título
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Ex.: Toneladas por hora"
                />
              </label>
              <label className="field">
                Largura
                <select
                  value={width}
                  onChange={(event) => setWidth(event.target.value as DashboardWidget['width'])}
                >
                  <option value="small">Pequena</option>
                  <option value="medium">Média</option>
                  <option value="large">Grande</option>
                  <option value="full">Linha inteira</option>
                </select>
              </label>
              <label className="field">
                Cor
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
              {widgetType === 'gauge' && (
                <>
                  <label className="field">
                    Mínimo
                    <input
                      type="number"
                      value={minimum}
                      onChange={(event) => setMinimum(Number(event.target.value))}
                    />
                  </label>
                  <label className="field">
                    Máximo
                    <input
                      type="number"
                      value={maximum}
                      onChange={(event) => setMaximum(Number(event.target.value))}
                    />
                  </label>
                </>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setAdding(false)}>
                Cancelar
              </button>
              <button className="primary-button" type="submit">
                Adicionar ao painel
              </button>
            </div>
          </form>
        </div>
      )}
      {tv && (
        <button className="tv-exit" onClick={() => setTv(false)}>
          Sair do modo TV
        </button>
      )}
    </div>
  );
}
