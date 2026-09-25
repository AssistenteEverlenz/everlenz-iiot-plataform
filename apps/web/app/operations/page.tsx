'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { PlantMap } from '../../components/PlantMap';
import { usePlatform } from '../../components/PlatformShell';
import { mutate, time, usePoll } from '../../components/data';

type Machine = {
  siteId: string;
  siteName: string;
  siteReference: string;
  deviceId: string;
  deviceName: string;
  deviceCode: string;
  dashboardId: string | null;
  state: string;
  product: string | null;
  updatedAt: string | null;
  metric: 'milheiros' | 'tons' | 'blocks' | 'pallets';
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  target: number | null;
  projection: number;
  pacePerHour: number;
  utilization: number | null;
};
type Site = {
  id: string;
  name: string;
  reference: string;
  state: string;
  location: {
    address: string | null;
    city: string | null;
    state: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  machines: Machine[];
};
type Overview = { generatedAt: string; productionDate: string; sites: Site[] };
const STATES: Record<string, { label: string; color: string }> = {
  producing: { label: 'Produzindo', color: '#13a875' },
  idle: { label: 'Ociosa', color: '#edae25' },
  manual: { label: 'Manual', color: '#805ad5' },
  pause: { label: 'Pausa', color: '#3b82f6' },
  offline: { label: 'Offline', color: '#d44b4b' },
  unknown: { label: 'Sem dados', color: '#789098' },
};
const METRICS = { milheiros: 'milheiros', tons: 't', blocks: 'peças', pallets: 'paletes' };
function number(value: number, decimals = 0) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: decimals }).format(value);
}
function value(machine: Machine) {
  return machine.metric === 'blocks' ? machine.totals.pieces : machine.totals[machine.metric];
}

export default function OperationsPage() {
  const { user } = usePlatform();
  const { data, error, loading, refresh } = usePoll<Overview>('/operations/overview', 5000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Site | null>(null);
  const sites = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('pt-BR');
    return (data?.sites ?? []).filter(
      (site) =>
        (filter === 'all' || site.state === filter) &&
        (!q ||
          `${site.name} ${site.reference} ${site.location.city ?? ''} ${site.machines.map((m) => `${m.deviceName} ${m.product ?? ''}`).join(' ')}`
            .toLocaleLowerCase('pt-BR')
            .includes(q)),
    );
  }, [data, filter, query]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(STATES).map((state) => [
          state,
          (data?.sites ?? []).filter((site) => site.state === state).length,
        ]),
      ),
    [data],
  );
  const select = useCallback((id: string) => {
    setSelected(id);
    document.getElementById(`plant-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);
  return (
    <div className="operations-page">
      <header className="operations-heading">
        <div>
          <span className="eyebrow">GESTÃO MULTICERÂMICAS</span>
          <h1>Operação em tempo real</h1>
          <p>Produção, ritmo e condição das plantas em uma única visão.</p>
        </div>
        <div className="operations-updated">
          <span className="live-dot" />
          Atualizado em {time(data?.generatedAt)}
        </div>
      </header>
      <section className="operations-kpis">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          <b>{data?.sites.length ?? 0}</b>
          <span>Cerâmicas monitoradas</span>
        </button>
        {['producing', 'idle', 'manual', 'offline'].map((state) => (
          <button
            key={state}
            className={filter === state ? 'active' : ''}
            onClick={() => setFilter(state)}
            style={{ '--state': STATES[state].color } as React.CSSProperties}
          >
            <b>{counts[state] ?? 0}</b>
            <span>
              <i />
              {STATES[state].label}
            </span>
          </button>
        ))}
      </section>
      <div className="operations-toolbar">
        <div className="search-field">
          <span>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar cerâmica, equipamento ou produto"
          />
        </div>
        <span>
          {sites.length} resultado{sites.length === 1 ? '' : 's'}
        </span>
      </div>
      {error && <div className="notice error">{error}</div>}
      {loading && <div className="empty">Carregando a operação…</div>}
      {data && (
        <div className="operations-main">
          <section className="map-panel">
            <PlantMap plants={sites} selected={selected} onSelect={select} />
            <div className="map-legend">
              {Object.entries(STATES)
                .slice(0, 5)
                .map(([key, item]) => (
                  <span key={key}>
                    <i style={{ background: item.color }} />
                    {item.label}
                  </span>
                ))}
            </div>
            {sites.some((s) => s.location.latitude == null) && (
              <p className="map-missing">
                {sites.filter((s) => s.location.latitude == null).length} cerâmica(s) ainda sem
                localização cadastrada.
              </p>
            )}
          </section>
          <section className="plant-list">
            {sites.map((site) => (
              <article
                id={`plant-${site.id}`}
                key={site.id}
                className={`plant-summary ${selected === site.id ? 'selected' : ''}`}
                onClick={() => setSelected(site.id)}
              >
                <header>
                  <div>
                    <span
                      className="state-pill"
                      style={
                        {
                          '--state': STATES[site.state]?.color ?? STATES.unknown.color,
                        } as React.CSSProperties
                      }
                    >
                      <i />
                      {STATES[site.state]?.label ?? 'Sem dados'}
                    </span>
                    <h2>{site.name}</h2>
                    <small>
                      {[site.location.city, site.location.state].filter(Boolean).join(' · ') ||
                        site.reference}
                    </small>
                  </div>
                  <div className="plant-actions">
                    {user.role === 'master' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(site);
                        }}
                      >
                        Localização
                      </button>
                    )}
                  </div>
                </header>
                <div className="machine-grid">
                  {site.machines.map((machine) => (
                    <div className="machine-row" key={machine.deviceId}>
                      <div className="machine-title">
                        <strong>{machine.deviceName}</strong>
                        <span>{machine.product || 'Produto não informado'}</span>
                      </div>
                      <Metric
                        label="Produzido hoje"
                        value={`${number(value(machine), machine.metric === 'tons' ? 1 : 0)} ${METRICS[machine.metric]}`}
                      />
                      <Metric
                        label="Meta"
                        value={
                          machine.target
                            ? `${number(machine.target)} ${METRICS[machine.metric]}`
                            : '—'
                        }
                      />
                      <Metric
                        label="Projeção"
                        value={`${number(machine.projection)} ${METRICS[machine.metric]}`}
                      />
                      <Metric
                        label="Ritmo"
                        value={`${number(machine.pacePerHour, 1)} ${METRICS[machine.metric]}/h`}
                      />
                      <Metric
                        label="Aproveitamento"
                        value={
                          machine.utilization == null
                            ? '—'
                            : `${number(machine.utilization * 100, 1)}%`
                        }
                      />
                      {machine.dashboardId && (
                        <Link
                          href={`/dashboards/${machine.dashboardId}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          Abrir painel →
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
                <footer>
                  Último sinal{' '}
                  {time(
                    site.machines.reduce<string | null>(
                      (latest, m) =>
                        !latest || (m.updatedAt && m.updatedAt > latest) ? m.updatedAt : latest,
                      null,
                    ),
                  )}
                </footer>
              </article>
            ))}
            {sites.length === 0 && (
              <div className="empty">Nenhuma cerâmica corresponde aos filtros.</div>
            )}
          </section>
        </div>
      )}
      {editing && (
        <LocationModal
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="machine-metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
function LocationModal({
  site,
  onClose,
  onSaved,
}: {
  site: Site;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    address: site.location.address ?? '',
    city: site.location.city ?? '',
    state: site.location.state ?? '',
    latitude: site.location.latitude?.toString() ?? '',
    longitude: site.location.longitude?.toString() ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setSaving(true);
    setError('');
    try {
      const latitude = form.latitude.trim() === '' ? null : Number(form.latitude.replace(',', '.'));
      const longitude =
        form.longitude.trim() === '' ? null : Number(form.longitude.replace(',', '.'));
      if (
        (latitude === null) !== (longitude === null) ||
        (latitude !== null && !Number.isFinite(latitude)) ||
        (longitude !== null && !Number.isFinite(longitude))
      )
        throw new Error('Informe latitude e longitude válidas.');
      await mutate(`/sites/${site.id}/location`, 'PATCH', { ...form, latitude, longitude });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card location-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">LOCALIZAÇÃO DA CERÂMICA</span>
            <h2>{site.name}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <p>
          As coordenadas são salvas uma vez e usadas no mapa. Você pode copiá-las do Google Maps.
        </p>
        <label>
          Endereço
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </label>
        <div className="form-row">
          <label>
            Cidade
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </label>
          <label>
            Estado
            <input
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Latitude
            <input
              inputMode="decimal"
              value={form.latitude}
              onChange={(e) => setForm({ ...form, latitude: e.target.value })}
              placeholder="-23,5505"
            />
          </label>
          <label>
            Longitude
            <input
              inputMode="decimal"
              value={form.longitude}
              onChange={(e) => setForm({ ...form, longitude: e.target.value })}
              placeholder="-46,6333"
            />
          </label>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Salvando…' : 'Salvar localização'}
          </button>
        </div>
      </div>
    </div>
  );
}
