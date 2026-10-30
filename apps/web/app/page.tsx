'use client';
import Link from 'next/link';
import { mutate, usePoll, time, type Device, type Topic } from '../components/data';
import { usePlatform } from '../components/PlatformShell';
import { metricInfo, type ProductionMetric } from '../components/ShiftBoard';

// The master's home: how each plant is doing right now, with what needs a look first. Plant users
// never see it (PlatformShell sends them to their own panel); the infrastructure sits folded at
// the end because it only matters when something is wrong with it.

type Machine = {
  siteName: string;
  deviceId: string;
  deviceName: string;
  dashboardId: string | null;
  state: string;
  stateSince: string | null;
  product: string | null;
  metric: ProductionMetric;
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  target: number | null;
  projection: number;
  pacePerHour: number;
};
type Overview = {
  generatedAt: string;
  productionDate: string;
  sites: Array<{ machines: Machine[] }>;
};
type MortarDay = { totals: { bags: number; targetBags: number } };
/** A connection with a plant's credential that did not look like its own HMI (migration 054). */
type ConnectionAlert = {
  id: string;
  device_name: string;
  client_id: string;
  ip: string | null;
  connected_at: string;
  disconnected_at: string | null;
  new_client: boolean;
  overlapped: boolean;
  usual_client: string | null;
  usual_ip: string | null;
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const hour = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** What happened, when, and which HMI it was against the plant's own. */
function connectionText(alert: ConnectionAlert) {
  const what = alert.overlapped
    ? 'outra IHM entrou com a credencial da fábrica'
    : 'uma IHM nova entrou com a credencial da fábrica';
  const end = alert.disconnected_at;
  const when = !end
    ? `desde ${day(alert.connected_at)} ${hour(alert.connected_at)}`
    : day(end) === day(alert.connected_at)
      ? `em ${day(alert.connected_at)}, das ${hour(alert.connected_at)} às ${hour(end)}`
      : `de ${day(alert.connected_at)} ${hour(alert.connected_at)} a ${day(end)} ${hour(end)}`;
  const own =
    alert.usual_client && alert.usual_client !== alert.client_id
      ? `; a da fábrica é ${alert.usual_client}`
      : '';
  return `${what} ${when} (${alert.client_id}${alert.ip ? `, ${alert.ip}` : ''}${own}).`;
}

/** A plant silent this long is a problem, not a night off. */
const SILENT_ALERT_MS = 24 * 3600_000;

const STATES: Record<string, string> = {
  producing: 'Produzindo',
  idle: 'Parada',
  manual: 'Parada manual',
  pause: 'Em pausa',
  offline: 'Sem comunicação',
  unknown: 'Sem dados',
};

const number = (value: number, decimals = 0) =>
  value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/** '45 min', '3h20', '5 dias'. */
function span(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours}h${String(minutes % 60).padStart(2, '0')}` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 dia' : `${days} dias`;
}

type Row = {
  id: string;
  name: string;
  site: string;
  href: string | null;
  state: string;
  silentFor: number | null;
  stateFor: number | null;
  product: string | null;
  made: number;
  unit: string;
  decimals: number;
  target: number | null;
  projection: number | null;
  pace: number | null;
};

function rowsOf(overview: Overview | null, devices: Device[] | null, mortar: MortarDay | null) {
  if (!overview) return [];
  const now = Date.parse(overview.generatedAt);
  const segment = new Map(devices?.map((item) => [item.id, item.site_segment]) ?? []);
  return overview.sites
    .flatMap((site) => site.machines)
    .map((machine): Row => {
      const since = machine.stateSince ? now - Date.parse(machine.stateSince) : null;
      const base = {
        id: machine.deviceId,
        name: machine.deviceName,
        site: machine.siteName,
        href: machine.dashboardId ? `/dashboards/${machine.dashboardId}` : null,
        state: machine.state,
        silentFor: machine.state === 'offline' ? since : null,
        stateFor: since,
        product: machine.product,
      };
      // A mortar line counts bags, which the ceramic overview does not know about.
      if (segment.get(machine.deviceId) === 'argamassa')
        return {
          ...base,
          made: mortar?.totals.bags ?? 0,
          unit: 'sacos',
          decimals: 0,
          target: mortar?.totals.targetBags || null,
          projection: null,
          pace: null,
        };
      const info = metricInfo[machine.metric] ?? metricInfo.pallets;
      const made =
        machine.metric === 'blocks' ? machine.totals.pieces : machine.totals[machine.metric];
      return {
        ...base,
        made,
        unit: info.unit,
        decimals: info.decimals,
        target: machine.target,
        // A silent plant has no pace to project: only what it made before going quiet.
        projection: machine.target && machine.state !== 'offline' ? machine.projection : null,
        pace: machine.pacePerHour,
      };
    });
}

/** Why a plant needs a look, or null when it does not. */
function concern(row: Row) {
  if (row.silentFor != null && row.silentFor >= SILENT_ALERT_MS)
    return `sem comunicação há ${span(row.silentFor)}`;
  if (row.state !== 'offline' && row.target && row.projection != null) {
    const share = row.projection / row.target;
    if (share < 0.9) return `no ritmo atual fecha em ${Math.round(share * 100)}% da meta`;
  }
  return null;
}

function tone(row: Row) {
  if (!row.target) return 'none';
  if (row.made >= row.target) return 'good';
  // Without a projection (a mortar line, a silent plant) half the target at noon is neither good
  // nor bad: the bar stays neutral rather than guessing.
  if (row.projection == null) return 'none';
  const share = row.projection / row.target;
  return share >= 1 ? 'good' : share >= 0.9 ? 'warn' : 'bad';
}

function summary(rows: Row[]) {
  const producing = rows.filter((row) => row.state === 'producing').length;
  const silent = rows.filter((row) => (row.silentFor ?? 0) >= SILENT_ALERT_MS).length;
  const behind = rows.filter(
    (row) => concern(row) && (row.silentFor ?? 0) < SILENT_ALERT_MS,
  ).length;
  const parts = [
    producing === 0
      ? 'Nenhuma fábrica produzindo agora'
      : producing === rows.length
        ? `${rows.length === 1 ? 'A fábrica está produzindo' : `As ${rows.length} fábricas estão produzindo`} agora`
        : `${producing} de ${rows.length} fábricas produzindo agora`,
  ];
  if (silent) parts.push(`${silent} sem comunicação há mais de um dia`);
  if (behind) parts.push(`${behind} abaixo do ritmo da meta`);
  return parts.length === 1
    ? `${parts[0]}.`
    : `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}.`;
}

function PlantRow({ row }: { row: Row }) {
  const scale = Math.max(row.target ?? 0, row.made, row.projection ?? 0) || 1;
  const stateText =
    row.state === 'offline'
      ? row.silentFor != null
        ? `Sem comunicação há ${span(row.silentFor)}`
        : 'Sem comunicação'
      : row.stateFor != null && row.stateFor >= 60_000
        ? `${STATES[row.state] ?? 'Sem dados'} há ${span(row.stateFor)}`
        : (STATES[row.state] ?? 'Sem dados');
  const content = (
    <>
      <div className="home-plant-name">
        <b>{row.name}</b>
        <span className={`home-state ${row.state}`}>
          <i aria-hidden="true" />
          {stateText}
        </span>
      </div>
      <div className="home-plant-made">
        <strong>{number(row.made, row.decimals)}</strong> <small>{row.unit} hoje</small>
      </div>
      <div className="home-plant-goal">
        {row.target ? (
          <>
            <div className={`home-bar ${tone(row)}`} aria-hidden="true">
              {row.projection != null && (
                <u style={{ width: `${Math.min(100, (row.projection / scale) * 100)}%` }} />
              )}
              <i style={{ width: `${Math.min(100, (row.made / scale) * 100)}%` }} />
              <s style={{ left: `${(row.target / scale) * 100}%` }} />
            </div>
            <small>
              meta {number(row.target, row.decimals)}
              {row.projection != null && row.state !== 'offline'
                ? `, fecha em ${number(row.projection, row.decimals)} (${Math.round((row.projection / row.target) * 100)}%)`
                : `, ${Math.round((row.made / row.target) * 100)}% feito`}
            </small>
          </>
        ) : (
          <small className="home-muted">sem meta cadastrada</small>
        )}
      </div>
      <div className="home-plant-pace">
        {row.pace != null && row.state !== 'offline' ? (
          <>
            <b>{number(row.pace, row.decimals)}</b> <small>{row.unit}/h</small>
          </>
        ) : (
          <small className="home-muted">—</small>
        )}
      </div>
    </>
  );
  return row.href ? (
    <Link className="home-plant" href={row.href} aria-label={`Abrir o painel de ${row.name}`}>
      {content}
    </Link>
  ) : (
    <div className="home-plant">{content}</div>
  );
}

export default function Home() {
  const overview = usePoll<Overview>('/operations/overview', 60000);
  const devices = usePoll<Device[]>('/devices?limit=200&offset=0', 300000);
  const day = overview.data?.productionDate;
  const hasMortar = devices.data?.some((item) => item.site_segment === 'argamassa');
  const mortar = usePoll<MortarDay>(
    day && hasMortar ? `/mortar/history?device=all&from=${day}&to=${day}&group=day` : null,
    120000,
  );
  const health = usePoll<{ broker: boolean; api: boolean }>('/health', 30000);
  const stats = usePoll<{
    devices: number;
    messagesPerMinute: number;
    lastMessageAt: string | null;
  }>('/overview', 30000);
  const topics = usePoll<Topic[]>('/mqtt/topics?limit=5', 30000);
  // Only the platform's master hears about a second HMI on a plant's credential.
  const { user } = usePlatform();
  const connections = usePoll<ConnectionAlert[]>(
    user.role === 'master' ? '/connections/alerts' : null,
    60000,
  );
  async function dismiss(id: string) {
    await mutate(`/connections/${id}/dismiss`, 'POST');
    await connections.refresh();
  }
  const alerts = connections.data ?? [];

  const rows = rowsOf(overview.data, devices.data, mortar.data);
  // What needs a look first, then the rest by name.
  const flagged = rows.filter((row) => concern(row));
  const ordered = [...rows].sort(
    (a, b) =>
      Number(Boolean(concern(b))) - Number(Boolean(concern(a))) ||
      a.name.localeCompare(b.name, 'pt-BR'),
  );
  const today = day
    ? new Date(`${day}T12:00:00`).toLocaleDateString('pt-BR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : null;

  return (
    <>
      <div className="heading home-heading">
        <div>
          <h1>Fábricas{today && <span className="home-date">{today}</span>}</h1>
          <p>{rows.length ? summary(rows) : 'Carregando as fábricas…'}</p>
        </div>
        <Link className="primary-button" href="/operations">
          Mapa e TV
        </Link>
      </div>
      {overview.error && (
        <div className="error-banner">
          Não foi possível ler as fábricas agora ({overview.error}). Veja a infraestrutura no fim da
          página.
        </div>
      )}

      {(flagged.length > 0 || alerts.length > 0) && (
        <section className="home-attention" aria-label="Precisa de atenção">
          <h2>Precisa de atenção</h2>
          <ul>
            {flagged.map((row) => (
              <li key={row.id}>
                {row.href ? <Link href={row.href}>{row.name}</Link> : <b>{row.name}</b>}
                <span>{concern(row)}</span>
              </li>
            ))}
            {alerts.map((alert) => (
              <li key={`connection-${alert.id}`} className="home-attention-connection">
                <b>{alert.device_name}</b>
                <span>{connectionText(alert)}</span>
                <button type="button" onClick={() => void dismiss(alert.id)}>
                  Dispensar
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card home-plants" aria-label="Fábricas">
        <div className="home-plants-head" aria-hidden="true">
          <span>Fábrica</span>
          <span>Hoje</span>
          <span>Meta</span>
          <span>Ritmo</span>
        </div>
        {ordered.map((row) => (
          <PlantRow key={row.id} row={row} />
        ))}
        {!rows.length && !overview.error && <p className="home-muted">Carregando…</p>}
      </section>

      <details className="home-infra">
        <summary>
          Infraestrutura
          <span>
            {health.error
              ? 'API indisponível'
              : health.data?.broker
                ? 'broker conectado'
                : 'verificando'}
            {stats.data && `, ${number(stats.data.messagesPerMinute)} mensagens por minuto`}
          </span>
        </summary>
        <div className="stats">
          <div className="card">
            <div className="stat-label">Broker MQTT / API</div>
            <div className="stat-value">
              {health.error ? 'Indisponível' : health.data?.broker ? 'Conectado' : '—'}
            </div>
            <div className="stat-note">Eclipse Mosquitto · self-hosted</div>
          </div>
          <div className="card">
            <div className="stat-label">Dispositivos</div>
            <div className="stat-value">{stats.data?.devices ?? '—'}</div>
            <div className="stat-note">Cadastrados neste tenant</div>
          </div>
          <div className="card">
            <div className="stat-label">Mensagens por minuto</div>
            <div className="stat-value">
              {stats.data?.messagesPerMinute.toLocaleString('pt-BR') ?? '—'}
            </div>
            <div className="stat-note">Ritmo recebido nos últimos 60 segundos</div>
          </div>
          <div className="card">
            <div className="stat-label">Última mensagem</div>
            <div className="stat-value" style={{ fontSize: 18 }}>
              {time(stats.data?.lastMessageAt)}
            </div>
            <div className="stat-note">Horário local do navegador</div>
          </div>
        </div>
        <section className="card">
          <h2>
            Atividade MQTT{' '}
            <Link className="device-link" href="/mqtt-inspector">
              ↗
            </Link>
          </h2>
          {topics.data?.map((t) => (
            <div key={t.topic} style={{ marginBottom: 14 }}>
              <div className="mono">{t.topic}</div>
              <div className="subline">
                {t.message_count} mensagens · {time(t.last_seen)}
              </div>
            </div>
          ))}
          {!topics.data?.length && <p>Aguardando publicações do simulador ou equipamento.</p>}
        </section>
      </details>
    </>
  );
}
