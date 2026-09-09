'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BrandSpinner, usePlatform } from './PlatformShell';
import { ActionModal } from './ActionModal';
import {
  mutate,
  time,
  usePoll,
  type Dashboard,
  type DashboardWidget,
  type Device,
  type Sample,
  type Signal,
} from './data';

interface Statistic {
  widget_id: string;
  tag_id: string;
  period_minutes: number;
  minimum_value: number;
  samples: number;
  ignored_samples: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  trend_per_second: number | null;
}

type AlarmRange = NonNullable<DashboardWidget['config']['alarmRanges']>[number];

function legacyAlarmRanges(widget: DashboardWidget, min: number, max: number): AlarmRange[] {
  const low = Math.max(min, Math.min(max, widget.config.warningLow ?? min + (max - min) * 0.6));
  const high = Math.max(low, Math.min(max, widget.config.warningHigh ?? min + (max - min) * 0.85));
  return [
    { id: 'normal', label: 'Normal', start: min, end: low, color: '#19a66f', priority: 0 },
    { id: 'attention', label: 'Atenção', start: low, end: high, color: '#e3a51f', priority: 1 },
    { id: 'critical', label: 'Crítico', start: high, end: max, color: '#dc3f45', priority: 2 },
  ].filter((range) => range.end > range.start);
}

function visibleGaugeZones(ranges: AlarmRange[], min: number, max: number) {
  const boundaries = Array.from(
    new Set([
      min,
      max,
      ...ranges.flatMap((range) => [
        Math.max(min, Math.min(max, range.start)),
        Math.max(min, Math.min(max, range.end)),
      ]),
    ]),
  ).sort((a, b) => a - b);
  return boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1];
    if (end <= start) return [];
    const middle = (start + end) / 2;
    const winner = [...ranges]
      .sort((a, b) => b.priority - a.priority)
      .find((range) => middle >= range.start && middle < range.end);
    if (!winner) return [];
    return [{ ...winner, start, end }];
  });
}

function number(value: number | null | undefined, decimals = 1) {
  return value == null
    ? '—'
    : value.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
}

function formatPeriod(minutes: number) {
  if (minutes >= 60 * 24 * 28) return 'último mês';
  if (minutes >= 60 * 24 * 7) return 'últimos 7 dias';
  if (minutes >= 60 * 24) return 'último dia';
  if (minutes >= 60) return `últimas ${minutes / 60} h`;
  return `últimos ${minutes} min`;
}

const visualizationHelp: Record<DashboardWidget['widget_type'], string> = {
  value: 'Mostra a leitura atual de uma variável numérica, booleana ou de texto.',
  line: 'Usa uma variável numérica e desenha sua evolução dentro da janela do painel.',
  gauge: 'Usa uma variável numérica com escala mínima, máxima e faixas coloridas.',
  status: 'Usa uma variável booleana: verdadeiro representa operação e falso representa parada.',
  production:
    'Usa uma taxa numérica, como ton/h. Calcula média, mínimo e pico no período configurado.',
  oee: 'O OEE não usa uma única variável. Precisa de tempo planejado, tempo operando, produção total, produção boa e ciclo ideal.',
  pareto: 'Precisa de eventos de parada com motivo e duração para ordenar as maiores perdas.',
};

function SixDots() {
  return (
    <span className="six-dots">
      {Array.from({ length: 6 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

function Widget({
  widget,
  latest,
  history,
  statistics,
  edit,
  remove,
  reset,
  dragStart,
  drop,
}: {
  widget: DashboardWidget;
  latest?: Sample;
  history: Sample[];
  statistics?: Statistic;
  edit: () => void;
  remove: () => void;
  reset: () => void;
  dragStart: () => void;
  drop: () => void;
}) {
  const color = widget.config.color ?? '#12b8a6';
  const rawNumeric = latest?.value_number ?? null;
  const numeric =
    rawNumeric == null || !widget.config.counterMode
      ? rawNumeric
      : rawNumeric < (widget.config.counterBaseline ?? 0)
        ? rawNumeric
        : rawNumeric - (widget.config.counterBaseline ?? 0);
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
  const ranges = widget.config.alarmRanges?.length
    ? widget.config.alarmRanges
    : legacyAlarmRanges(widget, min, max);
  const currentRange =
    widget.config.alarmEnabled && numeric != null
      ? [...ranges]
          .sort((a, b) => b.priority - a.priority)
          .find(
            (range) =>
              numeric >= range.start &&
              (numeric < range.end || (range.end === max && numeric <= range.end)),
          )
      : undefined;
  const activeColor = currentRange?.color ?? color;
  const gaugeZones = visibleGaugeZones(ranges, min, max);
  const thresholds = Array.from(
    new Map(
      ranges
        .filter((range) => range.end > min && range.end < max)
        .map((range) => [range.end, range]),
    ).values(),
  );
  return (
    <article
      draggable
      onDragStart={dragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      className={`dashboard-widget widget-${widget.width} ${currentRange ? 'alarm-active' : ''}`}
      style={{ '--accent': activeColor } as React.CSSProperties}
    >
      <div className="widget-head">
        <button className="drag-handle" title="Arrastar para reorganizar">
          <SixDots />
        </button>
        <div>
          <span className="widget-kicker">{widget.widget_type.toUpperCase()}</span>
          <h2>{widget.title}</h2>
        </div>
        <div className="widget-actions">
          <button className="icon-button" title="Editar indicador" onClick={edit}>
            ✎
          </button>
          <button className="icon-button danger-button" title="Remover" onClick={remove}>
            ×
          </button>
        </div>
      </div>
      {currentRange && currentRange.priority > 0 && (
        <div
          className="widget-alarm-label"
          style={{ color: currentRange.color, borderColor: currentRange.color }}
        >
          Faixa “{currentRange.label}” atingida
        </div>
      )}
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
                {widget.config.alarmEnabled &&
                  thresholds.map((range) => (
                    <ReferenceLine
                      key={`${range.id}-${range.end}`}
                      y={range.end}
                      stroke={range.color}
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                      label={{
                        value: `${range.label} ${number(range.end, widget.config.decimals ?? 1)}`,
                        position: 'insideTopLeft',
                        fill: range.color,
                        fontSize: 10,
                      }}
                    />
                  ))}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={activeColor}
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
        <div className={`gauge-v2 gauge-${widget.config.gaugeStyle ?? 'top'}`}>
          <div className="gauge-dial">
            <svg viewBox="0 0 220 132">
              <path className="gauge-track" pathLength="100" d="M 20 108 A 90 90 0 0 1 200 108" />
              {widget.config.alarmEnabled &&
                gaugeZones.map((zone, index) => {
                  const start = ((zone.start - min) / (max - min || 1)) * 100;
                  const length = ((zone.end - zone.start) / (max - min || 1)) * 100;
                  return (
                    <path
                      key={`${zone.id}-${index}`}
                      className="gauge-zone"
                      pathLength="100"
                      d="M 20 108 A 90 90 0 0 1 200 108"
                      style={{
                        stroke: zone.color,
                        strokeDasharray: `${length} ${100 - length}`,
                        strokeDashoffset: -start,
                      }}
                    />
                  );
                })}
              {widget.config.gaugeNeedle !== false && numeric != null && (
                <g className="gauge-needle">
                  <line
                    x1="110"
                    y1="108"
                    x2="110"
                    y2="38"
                    transform={`rotate(${progress * 1.8 - 90} 110 108)`}
                  />
                  <circle cx="110" cy="108" r="8" />
                </g>
              )}
            </svg>
            <div className="gauge-reading">
              <strong>{number(numeric, widget.config.decimals ?? 1)}</strong>
              <span>{widget.unit}</span>
            </div>
            <span className="gauge-limit gauge-limit-min">
              {number(min, widget.config.decimals ?? 1)}
            </span>
            <span className="gauge-limit gauge-limit-max">
              {number(max, widget.config.decimals ?? 1)}
            </span>
          </div>
        </div>
      )}
      {widget.widget_type === 'status' && (
        <div className={`machine-status ${latest?.value_boolean ? 'running' : ''}`}>
          <span className="status-orb" />
          <div>
            <strong>{latest?.value_boolean ? 'Em operação' : 'Parada'}</strong>
          </div>
        </div>
      )}
      {widget.widget_type === 'value' && (
        <>
          <div className="hero-value">
            {latest?.value_number != null
              ? number(latest.value_number, widget.config.decimals ?? 1)
              : latest?.value_boolean != null
                ? latest.value_boolean
                  ? 'Ligado'
                  : 'Desligado'
                : (latest?.value_text ?? '—')}
            <span>{widget.unit}</span>
          </div>
          {widget.config.counterMode && latest?.value_number != null && (
            <button className="counter-reset" type="button" onClick={reset}>
              Zerar contador
            </button>
          )}
        </>
      )}
      {widget.widget_type === 'production' && (
        <>
          <div className="hero-value">
            {number(statistics?.average, widget.config.decimals ?? 1)}
            <span>{widget.unit} média</span>
          </div>
          <div className="three-metrics">
            <span>
              <b>{number(statistics?.minimum, widget.config.decimals ?? 1)}</b>mínimo
            </span>
            <span>
              <b>{number(statistics?.maximum, widget.config.decimals ?? 1)}</b>pico
            </span>
            <span>
              <b>{statistics?.samples ?? 0}</b>amostras válidas
            </span>
          </div>
          <small className="production-note">
            Período: {formatPeriod(statistics?.period_minutes ?? 60)} · abaixo de{' '}
            {number(statistics?.minimum_value ?? 0.1, widget.config.decimals ?? 1)} ignorado
            {statistics?.ignored_samples ? ` · ${statistics.ignored_samples} descartadas` : ''}
          </small>
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
  const { branding } = usePlatform();
  const dashboard = usePoll<Dashboard>(`/dashboards/${id}`, 2000);
  const refreshMs = dashboard.data?.refresh_ms ?? 2000;
  const deviceId = dashboard.data?.device_id ?? '';
  const device = usePoll<Device>(deviceId ? `/devices/${deviceId}` : null, refreshMs);
  const latest = usePoll<Sample[]>(deviceId ? `/devices/${deviceId}/latest` : null, refreshMs);
  const signals = usePoll<Signal[]>(deviceId ? `/devices/${deviceId}/signals` : null, 5000);
  const statistics = usePoll<Statistic[]>(deviceId ? `/dashboards/${id}/statistics` : null, 30000);
  const windowMinutes = dashboard.data?.time_window_minutes ?? 60;
  const from = new Date(
    Math.floor(Date.now() / 60000) * 60000 - windowMinutes * 60000,
  ).toISOString();
  const history = usePoll<Sample[]>(
    deviceId ? `/telemetry?deviceId=${deviceId}&from=${encodeURIComponent(from)}&limit=2000` : null,
    refreshMs,
  );
  const [adding, setAdding] = useState(false);
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null>(null);
  const [tv, setTv] = useState(false);
  const [error, setError] = useState('');
  const [signalId, setSignalId] = useState('');
  const [widgetType, setWidgetType] = useState<DashboardWidget['widget_type']>('value');
  const [title, setTitle] = useState('');
  const [color, setColor] = useState('#12b8a6');
  const [width, setWidth] = useState<DashboardWidget['width']>('small');
  const [minimum, setMinimum] = useState(0);
  const [maximum, setMaximum] = useState(100);
  const [decimals, setDecimals] = useState(1);
  const [gaugeStyle, setGaugeStyle] = useState<'top' | 'bottom' | 'left' | 'right'>('top');
  const [alarmEnabled, setAlarmEnabled] = useState(false);
  const [alarmRanges, setAlarmRanges] = useState<AlarmRange[]>([]);
  const [gaugeNeedle, setGaugeNeedle] = useState(true);
  const [productionPeriodMinutes, setProductionPeriodMinutes] = useState(60);
  const [productionMinimumValue, setProductionMinimumValue] = useState(0.1);
  const [counterMode, setCounterMode] = useState(false);
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [savingModal, setSavingModal] = useState(false);
  const [savingRefresh, setSavingRefresh] = useState(false);
  const [removingWidget, setRemovingWidget] = useState<DashboardWidget | null>(null);
  const [resettingWidget, setResettingWidget] = useState<DashboardWidget | null>(null);
  useEffect(() => {
    if (dashboard.data?.widgets)
      setWidgets([...dashboard.data.widgets].sort((a, b) => a.position - b.position));
  }, [dashboard.data?.widgets]);
  const allLoaded = Boolean(
    dashboard.data && device.data && latest.data && signals.data && statistics.data && history.data,
  );
  useEffect(() => {
    if (allLoaded) setLoadedOnce(true);
  }, [allLoaded]);
  useEffect(() => {
    const timer = window.setTimeout(() => setLoadingTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
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
    setSavingModal(true);
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
        config: {
          color: '#12b8a6',
          min: 0,
          max: 100,
          decimals: 1,
          gaugeStyle: 'top',
          gaugeNeedle: true,
          productionPeriodMinutes: 60,
          productionMinimumValue: 0.1,
        },
      });
      setAdding(false);
      await Promise.all([dashboard.refresh(), signals.refresh()]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Não foi possível adicionar o indicador.',
      );
    } finally {
      setSavingModal(false);
    }
  }
  async function updateRefresh(refresh: number) {
    setSavingRefresh(true);
    try {
      await mutate(`/dashboards/${id}`, 'PATCH', { refreshMs: refresh });
      await dashboard.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar');
    } finally {
      setSavingRefresh(false);
    }
  }
  function startEdit(widget: DashboardWidget) {
    setEditingWidget(widget);
    setTitle(widget.title);
    setWidth(widget.width);
    setColor(widget.config.color ?? '#12b8a6');
    setMinimum(widget.config.min ?? 0);
    setMaximum(widget.config.max ?? 100);
    setDecimals(widget.config.decimals ?? 1);
    setGaugeStyle(widget.config.gaugeStyle ?? 'top');
    setAlarmEnabled(widget.config.alarmEnabled ?? false);
    setAlarmRanges(
      widget.config.alarmRanges?.length
        ? widget.config.alarmRanges
        : legacyAlarmRanges(widget, widget.config.min ?? 0, widget.config.max ?? 100),
    );
    setGaugeNeedle(widget.config.gaugeNeedle ?? true);
    setProductionPeriodMinutes(widget.config.productionPeriodMinutes ?? 60);
    setProductionMinimumValue(widget.config.productionMinimumValue ?? 0.1);
    setCounterMode(widget.config.counterMode ?? false);
  }
  async function saveWidget(event: React.FormEvent) {
    event.preventDefault();
    if (!editingWidget) return;
    if (maximum <= minimum) return setError('O valor máximo precisa ser maior que o mínimo.');
    if (
      alarmEnabled &&
      alarmRanges.some(
        (range) =>
          !range.label.trim() ||
          range.end <= range.start ||
          (editingWidget.widget_type === 'gauge' && (range.start < minimum || range.end > maximum)),
      )
    )
      return setError('Revise as faixas: nome, início e fim precisam estar dentro do medidor.');
    setSavingModal(true);
    setError('');
    try {
      await mutate(`/dashboards/${id}/widgets/${editingWidget.id}`, 'PATCH', {
        title,
        width,
        config: {
          color,
          min: minimum,
          max: maximum,
          decimals,
          gaugeStyle,
          gaugeNeedle,
          alarmEnabled,
          alarmRanges,
          productionPeriodMinutes,
          productionMinimumValue,
          counterMode,
        },
      });
      setEditingWidget(null);
      await dashboard.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar indicador.');
    } finally {
      setSavingModal(false);
    }
  }
  async function removeWidget(widget: DashboardWidget) {
    await mutate(`/dashboards/${id}/widgets/${widget.id}`, 'DELETE');
    setEditingWidget(null);
    await dashboard.refresh();
  }
  async function resetCounter(widget: DashboardWidget) {
    const current = widget.tag_id ? byTag.get(widget.tag_id)?.value_number : null;
    if (current == null) throw new Error('O contador ainda não possui um valor numérico válido.');
    await mutate(`/dashboards/${id}/widgets/${widget.id}`, 'PATCH', {
      config: { counterMode: true, counterBaseline: current },
    });
    await dashboard.refresh();
  }
  async function dropWidget(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const next = [...widgets];
    const fromIndex = next.findIndex((widget) => widget.id === draggedId);
    const toIndex = next.findIndex((widget) => widget.id === targetId);
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setWidgets(next);
    setDraggedId(null);
    try {
      await mutate(`/dashboards/${id}/layout`, 'PATCH', {
        widgetIds: next.map((widget) => widget.id),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar a ordem.');
      await dashboard.refresh();
    }
  }
  if (!loadedOnce) {
    const loadError =
      dashboard.error ||
      device.error ||
      latest.error ||
      signals.error ||
      statistics.error ||
      history.error;
    if (loadingTimedOut && loadError)
      return (
        <div className="dashboard-load-failed">
          <BrandSpinner branding={branding} />
          <h2>Não foi possível carregar o painel</h2>
          <p>{loadError}</p>
          <button onClick={() => window.location.reload()}>Tentar novamente</button>
        </div>
      );
    return (
      <div className="dashboard-loading">
        <BrandSpinner branding={branding} />
        <strong>Carregando dados do equipamento…</strong>
      </div>
    );
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
          <a
            className="secondary-button"
            href={`/api/export/telemetry.csv?deviceId=${deviceId}&limit=10000`}
          >
            Exportar CSV
          </a>
          <button onClick={() => setTv(!tv)}>{tv ? 'Sair da TV' : 'Modo TV'}</button>
          <button className="primary-button" onClick={() => setAdding(true)}>
            + Adicionar indicador
          </button>
        </div>
      </div>
      <div className="editor-bar">
        <span>
          Arraste os seis pontos para organizar. A configuração fica salva neste equipamento.
        </span>
        <label>
          Atualização {savingRefresh && <span className="button-spinner dark" />}
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
        <small>
          A IHM também precisa publicar neste intervalo para chegar um valor novo a cada ciclo.
        </small>
      </div>
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
          <b>Atualizado em</b> {time(device.data?.last_message_at)}
        </span>
      </div>
      <section className="widget-grid">
        {widgets.map((widget) => (
          <Widget
            key={widget.id}
            widget={widget}
            latest={widget.tag_id ? byTag.get(widget.tag_id) : undefined}
            history={history.data ?? []}
            statistics={statistics.data?.find((item) => item.widget_id === widget.id)}
            edit={() => startEdit(widget)}
            remove={() => setRemovingWidget(widget)}
            reset={() => setResettingWidget(widget)}
            dragStart={() => setDraggedId(widget.id)}
            drop={() => void dropWidget(widget.id)}
          />
        ))}
        {!widgets.length && (
          <button className="empty-dashboard" onClick={() => setAdding(true)}>
            +<strong>Monte a primeira visão da operação</strong>
            <span>Escolha uma variável que já chegou pelo MQTT.</span>
          </button>
        )}
      </section>
      <footer className="dashboard-footer">
        <span>EVERLENZ INDUSTRIAL INTELLIGENCE</span>
        <span>Dados recebidos via MQTT · atualização automática</span>
      </footer>
      {adding && (
        <div className="modal-backdrop" onMouseDown={() => !savingModal && setAdding(false)}>
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
              <button
                type="button"
                disabled={savingModal}
                className="icon-button"
                onClick={() => setAdding(false)}
              >
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
              <div className="field full-field">
                Visualização
                <div className="visualization-picker">
                  {(
                    [
                      ['value', '42', 'Valor'],
                      ['line', '∿', 'Tendência'],
                      ['gauge', '◒', 'Medidor'],
                      ['status', '●', 'Estado'],
                      ['production', '▥', 'Produção'],
                      ['oee', '%', 'OEE'],
                      ['pareto', '▥', 'Pareto'],
                    ] as const
                  ).map(([type, icon, label]) => (
                    <button
                      type="button"
                      key={type}
                      className={widgetType === type ? 'selected' : ''}
                      onClick={() => setWidgetType(type)}
                    >
                      <span className="visualization-symbol">{icon}</span>
                      <b>{label}</b>
                      <span className="visualization-info" title={visualizationHelp[type]}>
                        i
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                Título
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Ex.: Toneladas por hora"
                />
              </label>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" disabled={savingModal} onClick={() => setAdding(false)}>
                Cancelar
              </button>
              <button className="primary-button" type="submit" disabled={savingModal}>
                {savingModal && <span className="button-spinner" />}
                {savingModal ? 'Adicionando…' : 'Adicionar ao painel'}
              </button>
            </div>
          </form>
        </div>
      )}
      {editingWidget && (
        <div className="modal-backdrop" onMouseDown={() => !savingModal && setEditingWidget(null)}>
          <form
            className="modal-card widget-settings-modal"
            onSubmit={saveWidget}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-title">
              <div>
                <div className="eyebrow">CONFIGURAÇÃO DO ITEM</div>
                <h2>{editingWidget.title}</h2>
              </div>
              <button
                type="button"
                disabled={savingModal}
                className="icon-button"
                onClick={() => setEditingWidget(null)}
              >
                ×
              </button>
            </div>
            <div className="form-grid">
              <label className="field full-field">
                Título
                <input required value={title} onChange={(event) => setTitle(event.target.value)} />
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
                Casas decimais
                <input
                  type="number"
                  min="0"
                  max="6"
                  value={decimals}
                  onChange={(event) => setDecimals(Number(event.target.value))}
                />
              </label>
              <label className="field">
                Cor
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
              {editingWidget.widget_type === 'gauge' && (
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
                  <div className="field full-field">
                    Posição do medidor
                    <div className="gauge-style-picker">
                      {(['top', 'bottom', 'left', 'right'] as const).map((style) => (
                        <button
                          type="button"
                          key={style}
                          className={gaugeStyle === style ? 'selected' : ''}
                          onClick={() => setGaugeStyle(style)}
                        >
                          <span className={`mini-gauge mini-${style}`} />
                          {
                            {
                              top: 'Superior',
                              bottom: 'Inferior',
                              left: 'Esquerda',
                              right: 'Direita',
                            }[style]
                          }
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="check-field full-field">
                    <input
                      type="checkbox"
                      checked={gaugeNeedle}
                      onChange={(event) => setGaugeNeedle(event.target.checked)}
                    />
                    Exibir ponteiro no medidor
                  </label>
                </>
              )}
              {editingWidget.widget_type === 'production' && (
                <>
                  <label className="field">
                    Período analisado
                    <select
                      value={productionPeriodMinutes}
                      onChange={(event) => setProductionPeriodMinutes(Number(event.target.value))}
                    >
                      <option value={10}>Últimos 10 minutos</option>
                      <option value={30}>Últimos 30 minutos</option>
                      <option value={60}>Última hora</option>
                      <option value={360}>Últimas 6 horas</option>
                      <option value={720}>Últimas 12 horas</option>
                      <option value={1440}>Último dia</option>
                      <option value={10080}>Últimos 7 dias</option>
                      <option value={43200}>Último mês</option>
                    </select>
                  </label>
                  <label className="field">
                    Desconsiderar valores abaixo de
                    <input
                      type="number"
                      step="any"
                      value={productionMinimumValue}
                      onChange={(event) => setProductionMinimumValue(Number(event.target.value))}
                    />
                  </label>
                  <small className="full-field alarm-range-help">
                    A média operacional ignora períodos parados abaixo desse valor. Mínimo, pico e
                    quantidade de amostras usam o mesmo filtro.
                  </small>
                </>
              )}
              {editingWidget.widget_type === 'value' && editingWidget.data_type === 'number' && (
                <>
                  <label className="check-field full-field">
                    <input
                      type="checkbox"
                      checked={counterMode}
                      onChange={(event) => setCounterMode(event.target.checked)}
                    />
                    Tratar esta variável como contador acumulativo
                  </label>
                  <small className="full-field alarm-range-help">
                    O botão “Zerar contador” cria uma referência no painel e mantém o CLP intacto.
                    Os próximos incrementos continuam aparecendo normalmente.
                  </small>
                </>
              )}
              <label className="check-field full-field">
                <input
                  type="checkbox"
                  checked={alarmEnabled}
                  onChange={(event) => setAlarmEnabled(event.target.checked)}
                />
                Ativar alarme visual por limite
              </label>
              {alarmEnabled && (
                <div className="full-field alarm-ranges-editor">
                  <div className="alarm-ranges-title">
                    <div>
                      <strong>Faixas de operação</strong>
                      <small>
                        Em uma sobreposição, a faixa com maior prioridade define a cor e o alerta.
                      </small>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAlarmRanges((current) => [
                          ...current,
                          {
                            id: crypto.randomUUID(),
                            label: `Faixa ${current.length + 1}`,
                            start: minimum,
                            end: maximum,
                            color: '#12b8a6',
                            priority: current.length,
                          },
                        ])
                      }
                    >
                      + Adicionar faixa
                    </button>
                  </div>
                  {alarmRanges.map((range) => (
                    <div className="alarm-range-row" key={range.id}>
                      <label>
                        Nome
                        <input
                          value={range.label}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Início
                        <input
                          type="number"
                          step="any"
                          value={range.start}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, start: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Final
                        <input
                          type="number"
                          step="any"
                          value={range.end}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, end: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Cor
                        <input
                          type="color"
                          value={range.color}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, color: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Prioridade
                        <input
                          type="number"
                          min="0"
                          value={range.priority}
                          onChange={(event) =>
                            setAlarmRanges((current) =>
                              current.map((item) =>
                                item.id === range.id
                                  ? { ...item, priority: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="alarm-range-remove"
                        aria-label={`Remover ${range.label}`}
                        onClick={() =>
                          setAlarmRanges((current) =>
                            current.filter((item) => item.id !== range.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {!alarmRanges.length && <small>Adicione ao menos uma faixa de operação.</small>}
                </div>
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button
                type="button"
                disabled={savingModal}
                className="danger-text"
                onClick={() => setRemovingWidget(editingWidget)}
              >
                Excluir item
              </button>
              <button type="button" disabled={savingModal} onClick={() => setEditingWidget(null)}>
                Cancelar
              </button>
              <button className="primary-button" disabled={savingModal}>
                {savingModal && <span className="button-spinner" />}
                {savingModal ? 'Salvando…' : 'Salvar configuração'}
              </button>
            </div>
          </form>
        </div>
      )}
      {removingWidget && (
        <ActionModal
          title="Excluir indicador"
          description={`O item “${removingWidget.title}” será removido deste painel compartilhado para todos os usuários.`}
          confirmLabel="Excluir indicador"
          danger
          onClose={() => setRemovingWidget(null)}
          onConfirm={() => removeWidget(removingWidget)}
        />
      )}
      {resettingWidget && (
        <ActionModal
          title="Zerar contador"
          description={`O valor exibido em “${resettingWidget.title}” começará novamente em zero e continuará acompanhando os próximos incrementos do equipamento. O valor original no CLP será preservado.`}
          confirmLabel="Zerar agora"
          onClose={() => setResettingWidget(null)}
          onConfirm={() => resetCounter(resettingWidget)}
        />
      )}
      {tv && (
        <div className="tv-controls">
          <span>Atualizado em {time(device.data?.last_message_at)}</span>
          <button className="tv-exit" onClick={() => setTv(false)}>
            Sair da TV
          </button>
        </div>
      )}
    </div>
  );
}
