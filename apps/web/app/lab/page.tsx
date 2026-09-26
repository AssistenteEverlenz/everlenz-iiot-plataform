'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePlatform } from '../../components/PlatformShell';
import { formatNumber, ShiftBoardView, type ShiftBoardResponse } from '../../components/ShiftBoard';
import { ShiftDetailCharts, type DetailData } from '../../components/ShiftDetailModal';
import { usePoll, type Device } from '../../components/data';

// Laboratory (master only): the plant's real data shown as it is today and as it would be once
// the readings of a closed shift are discarded, so the limits can be judged before any client
// sees them. Nothing on this page changes data.

interface Storage {
  hours: Array<{ hour: string; samples: number; raw: number }>;
  totals: {
    samples: number;
    raw: number;
    rollups: number;
    buckets: number;
    reports: number;
    first_sample: string | null;
  };
}
interface Report {
  id: string;
  production_date: string;
  shift_name: string;
  kind: 'shift' | 'off_shift';
  planned_start: string | null;
  planned_end: string | null;
  open?: boolean;
  pallets: number | string;
  pieces: number | string;
}
interface Snapshot {
  photo: {
    detail: ShiftBoardResponse;
    charts: DetailData;
    minutes: Array<{ t: string; value: number }>;
  };
  bytes: number;
  liveMs: number;
  readings: number;
}
interface Tag {
  id: string;
  key: string;
  name: string;
  data_type: string;
}

const plantDay = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
const clock = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
const shortDate = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(
    new Date(`${value}T12:00:00`),
  );
const size = (bytes: number) =>
  bytes > 1_000_000 ? `${formatNumber(bytes / 1_000_000, 1)} MB` : `${formatNumber(bytes / 1000, 1)} KB`;

export default function LabPage() {
  const { user } = usePlatform();
  const devices = usePoll<Device[]>('/devices?limit=200&offset=0', 60000);
  const [deviceId, setDeviceId] = useState('');
  useEffect(() => {
    if (!deviceId && devices.data?.length) setDeviceId(devices.data[0].id);
  }, [devices.data, deviceId]);
  if (user.role !== 'master') return <div className="empty">Área restrita ao administrador.</div>;
  return (
    <div className="lab-page">
      <div className="heading">
        <div>
          <div className="eyebrow">LABORATÓRIO · SÓ PARA O MASTER</div>
          <h1>Como fica sem as leituras antigas</h1>
          <p>
            Dados reais do equipamento, lado a lado: como a plataforma mostra hoje e como mostraria
            guardando só a fotografia do turno e os resumos. Nada aqui altera dados.
          </p>
        </div>
        <label className="lab-device">
          Equipamento
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.data?.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {deviceId && (
        <>
          <StorageSection deviceId={deviceId} />
          <PhotoSection deviceId={deviceId} />
          <VariableSection deviceId={deviceId} />
          <LimitsSection />
        </>
      )}
    </div>
  );
}

function StorageSection({ deviceId }: { deviceId: string }) {
  const storage = usePoll<Storage>(`/lab/devices/${deviceId}/storage`, 60000);
  const data = (storage.data?.hours ?? []).map((item) => ({
    ...item,
    label: `${shortDate(plantDay(new Date(item.hour)))} ${clock(item.hour)}`,
  }));
  const totals = storage.data?.totals;
  return (
    <section className="card lab-section">
      <div className="lab-section-head">
        <div>
          <span className="eyebrow">1 · ARMAZENAMENTO</span>
          <h2>Quanto este equipamento grava por hora</h2>
          <p>
            Leituras e mensagens brutas das últimas 48 horas. A partir do deploy de hoje, uma
            leitura só é gravada quando o valor muda, e a mensagem bruta só no diagnóstico.
          </p>
        </div>
      </div>
      {totals && (
        <div className="lab-kpis">
          <div>
            <span>Leituras guardadas</span>
            <b>{formatNumber(totals.samples)}</b>
          </div>
          <div>
            <span>Mensagens brutas</span>
            <b>{formatNumber(totals.raw)}</b>
          </div>
          <div>
            <span>Resumos por hora</span>
            <b>{formatNumber(totals.rollups)}</b>
          </div>
          <div>
            <span>Produção a cada 5 min</span>
            <b>{formatNumber(totals.buckets)}</b>
          </div>
          <div>
            <span>Turnos fechados</span>
            <b>{formatNumber(totals.reports)}</b>
          </div>
        </div>
      )}
      <div className="lab-chart">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={5} />
            <YAxis tick={{ fontSize: 10 }} width={48} />
            <Tooltip />
            <Legend />
            <Bar dataKey="samples" name="Leituras por hora" fill="#12b8a6" />
            <Bar dataKey="raw" name="Mensagens brutas por hora" fill="#e3a51c" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PhotoSection({ deviceId }: { deviceId: string }) {
  const today = plantDay(new Date());
  const from = plantDay(new Date(Date.now() - 14 * 86400_000));
  const reports = usePoll<{ reports: Report[] }>(
    `/devices/${deviceId}/shift-reports?from=${from}&to=${today}`,
    300000,
  );
  const closed = (reports.data?.reports ?? [])
    .filter((report) => !report.open && report.kind === 'shift' && report.planned_start && report.planned_end)
    .slice(0, 20);
  const [chosen, setChosen] = useState<Report | null>(null);
  useEffect(() => setChosen(null), [deviceId]);
  return (
    <section className="card lab-section">
      <div className="lab-section-head">
        <div>
          <span className="eyebrow">2 · FOTOGRAFIA DO TURNO</span>
          <h2>Um turno fechado, lido das leituras e lido só da fotografia</h2>
          <p>
            Escolha um turno. À esquerda, o detalhe como ele é montado hoje, consultando as
            leituras. À direita, o mesmo detalhe a partir de uma fotografia única, gravada no
            fechamento: o que fica quando as leituras são apagadas.
          </p>
        </div>
      </div>
      <div className="lab-shift-list">
        {closed.map((report) => (
          <button
            key={report.id}
            className={chosen?.id === report.id ? 'active' : ''}
            onClick={() => setChosen(report)}
          >
            <b>{shortDate(report.production_date)}</b>
            <span>{report.shift_name}</span>
            <small>
              {clock(report.planned_start!)}–{clock(report.planned_end!)}
            </small>
          </button>
        ))}
        {reports.data && !closed.length && <p className="shifts-help">Nenhum turno fechado nos últimos 14 dias.</p>}
      </div>
      {chosen && <PhotoCompare key={chosen.id} deviceId={deviceId} report={chosen} />}
    </section>
  );
}

function PhotoCompare({ deviceId, report }: { deviceId: string; report: Report }) {
  const params = new URLSearchParams({
    date: report.production_date,
    kind: 'shift',
    start: report.planned_start!,
    end: report.planned_end!,
  });
  const window = `&from=${encodeURIComponent(report.planned_start!)}&to=${encodeURIComponent(report.planned_end!)}`;
  const [liveMs, setLiveMs] = useState<number | null>(null);
  const [started] = useState(() => performance.now());
  const detail = usePoll<ShiftBoardResponse>(`/devices/${deviceId}/production-detail?${params}`, 600000);
  const charts = usePoll<DetailData>(`/devices/${deviceId}/shift-detail?mode=shift${window}`, 600000);
  useEffect(() => {
    if (detail.data && charts.data && liveMs == null) setLiveMs(performance.now() - started);
  }, [detail.data, charts.data, liveMs, started]);
  const snapshot = usePoll<Snapshot>(`/lab/devices/${deviceId}/snapshot?${params}`, 600000);
  // Opening a photo is reading one stored value: measured here by serialising it back.
  const photoOpenMs = useMemo(() => {
    if (!snapshot.data) return null;
    const begin = performance.now();
    JSON.parse(JSON.stringify(snapshot.data.photo));
    return performance.now() - begin;
  }, [snapshot.data]);
  return (
    <div className="lab-compare">
      <div className="lab-side">
        <div className="lab-side-head">
          <strong>Hoje · consulta às leituras</strong>
          <small>
            {snapshot.data ? `${formatNumber(snapshot.data.readings)} leituras no turno` : '…'}
            {liveMs != null ? ` · abriu em ${formatNumber(liveMs / 1000, 1)} s` : ''}
          </small>
        </div>
        {detail.data ? (
          <>
            <ShiftBoardView data={detail.data} deviceId={deviceId} historical />
            <ShiftDetailCharts data={charts.data} focus="produced" />
          </>
        ) : (
          <div className="production-detail-loading">
            <span className="detail-spinner" aria-label="Carregando" />
          </div>
        )}
      </div>
      <div className="lab-side lab-photo">
        <div className="lab-side-head">
          <strong>Fotografia · sem leituras</strong>
          <small>
            {snapshot.data
              ? `1 registro de ${size(snapshot.data.bytes)} · abre em ${formatNumber(photoOpenMs ?? 0, 1)} ms`
              : snapshot.error ?? 'Montando a fotografia…'}
          </small>
        </div>
        {snapshot.data ? (
          <>
            <ShiftBoardView
              data={snapshot.data.photo.detail}
              deviceId={deviceId}
              historical
              minuteSeries={snapshot.data.photo.minutes}
            />
            <ShiftDetailCharts data={snapshot.data.photo.charts} focus="produced" />
          </>
        ) : (
          <div className="production-detail-loading">
            {snapshot.error ? <p>{snapshot.error}</p> : <span className="detail-spinner" aria-label="Carregando" />}
          </div>
        )}
      </div>
    </div>
  );
}

function VariableSection({ deviceId }: { deviceId: string }) {
  const tags = usePoll<Tag[]>(`/devices/${deviceId}/tags`, 300000);
  const numeric = (tags.data ?? []).filter((tag) => tag.data_type === 'number');
  const [tagId, setTagId] = useState('');
  const [day, setDay] = useState(() => plantDay(new Date(Date.now() - 86400_000)));
  useEffect(() => {
    if (numeric.length && !numeric.some((tag) => tag.id === tagId)) setTagId(numeric[0].id);
  }, [numeric, tagId]);
  const from = new Date(`${day}T00:00:00-03:00`).toISOString();
  const to = new Date(new Date(from).getTime() + 86400_000).toISOString();
  const series = usePoll<{
    full: Array<{ t: string; value: number }>;
    hourly: Array<{ t: string; average: number; minimum: number; maximum: number; last: number }>;
  }>(
    tagId
      ? `/lab/devices/${deviceId}/variable?tagId=${tagId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      : null,
    600000,
  );
  const full = (series.data?.full ?? []).map((point) => ({
    t: new Date(point.t).getTime(),
    value: Number(point.value),
  }));
  const hourly = (series.data?.hourly ?? []).map((point) => ({
    t: new Date(point.t).getTime() + 1800_000,
    average: Number(point.average),
    minimum: Number(point.minimum),
    maximum: Number(point.maximum),
  }));
  const domain: [number, number] = [new Date(from).getTime(), new Date(to).getTime()];
  const axis = (value: number) => clock(new Date(value).toISOString());
  return (
    <section className="card lab-section">
      <div className="lab-section-head">
        <div>
          <span className="eyebrow">3 · VARIÁVEL DE UM DIA PASSADO</span>
          <h2>O gráfico de uma variável depois que as leituras saem</h2>
          <p>
            Em cima, todas as leituras do dia. Embaixo, só o resumo por hora que fica guardado:
            média, mínimo e máximo de cada hora.
          </p>
        </div>
        <div className="lab-filters">
          <label>
            Variável
            <select value={tagId} onChange={(event) => setTagId(event.target.value)}>
              {numeric.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name || tag.key}
                </option>
              ))}
            </select>
          </label>
          <label>
            Dia
            <input type="date" value={day} max={plantDay(new Date())} onChange={(event) => setDay(event.target.value)} />
          </label>
        </div>
      </div>
      <div className="lab-variable">
        <div>
          <small>Todas as leituras · {formatNumber(full.length)} pontos</small>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={full} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" type="number" domain={domain} tickFormatter={axis} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={48} />
              <Tooltip labelFormatter={(value) => axis(Number(value))} />
              <Line dataKey="value" name="Leitura" stroke="#12b8a6" dot={false} type="stepAfter" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div>
          <small>Só o resumo por hora · {formatNumber(hourly.length)} pontos</small>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={hourly} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" type="number" domain={domain} tickFormatter={axis} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={48} />
              <Tooltip labelFormatter={(value) => axis(Number(value))} />
              <Legend />
              <Line dataKey="maximum" name="Máximo" stroke="#e3a51c" dot={false} isAnimationActive={false} />
              <Line dataKey="average" name="Média" stroke="#12b8a6" dot isAnimationActive={false} />
              <Line dataKey="minimum" name="Mínimo" stroke="#6d8087" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function LimitsSection() {
  return (
    <section className="card lab-section">
      <div className="lab-section-head">
        <div>
          <span className="eyebrow">4 · O QUE MUDA PARA O CLIENTE</span>
          <h2>Depois que as leituras de um turno fechado são apagadas</h2>
        </div>
      </div>
      <div className="lab-limits">
        <div className="lab-keep">
          <strong>Continua igual</strong>
          <ul>
            <li>Detalhe do turno fechado: quadro, curva S com zoom minuto a minuto, paletes, gráficos por hora (seção 2).</li>
            <li>Histórico de produção, calendário de metas, CSV por produto.</li>
            <li>Gráficos por dia e por produto (barras, rosca, 7 dias, mês, ano): já leem os resumos por hora, não as leituras.</li>
            <li>Painel e TV ao vivo, turno em andamento, ritmo, projeção e meta.</li>
          </ul>
        </div>
        <div className="lab-lose">
          <strong>Deixa de existir para turnos já apagados</strong>
          <ul>
            <li>Recalcular um turno antigo (corrigir peso, vírgula ou contador depois do fato).</li>
            <li>Conferir com a IHM dias antigos.</li>
            <li>Gráfico de uma variável segundo a segundo num dia passado: fica por hora (seção 3).</li>
            <li>Exportar o CSV das leituras daqueles dias.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
