'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  location: Location;
};
type Location = {
  address: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
};
type Site = {
  id: string;
  name: string;
  reference: string;
  state: string;
  machines: Machine[];
};
type Overview = { generatedAt: string; productionDate: string; sites: Site[] };
const STATES: Record<string, { label: string; color: string }> = {
  producing: { label: 'Produzindo', color: '#1fbf7a' },
  idle: { label: 'Ociosa', color: '#f2a93b' },
  manual: { label: 'Manual / parada', color: '#e4572e' },
  pause: { label: 'Pausa', color: '#cdb9ea' },
  offline: { label: 'Sem comunicação', color: '#98a6ab' },
  unknown: { label: 'Sem dados', color: '#98a6ab' },
};
const METRICS = { milheiros: 'milheiros', tons: 't', blocks: 'peças', pallets: 'paletes' };
const BRAZIL_STATES = [
  ['AC', 'Acre'],
  ['AL', 'Alagoas'],
  ['AP', 'Amapá'],
  ['AM', 'Amazonas'],
  ['BA', 'Bahia'],
  ['CE', 'Ceará'],
  ['DF', 'Distrito Federal'],
  ['ES', 'Espírito Santo'],
  ['GO', 'Goiás'],
  ['MA', 'Maranhão'],
  ['MT', 'Mato Grosso'],
  ['MS', 'Mato Grosso do Sul'],
  ['MG', 'Minas Gerais'],
  ['PA', 'Pará'],
  ['PB', 'Paraíba'],
  ['PR', 'Paraná'],
  ['PE', 'Pernambuco'],
  ['PI', 'Piauí'],
  ['RJ', 'Rio de Janeiro'],
  ['RN', 'Rio Grande do Norte'],
  ['RS', 'Rio Grande do Sul'],
  ['RO', 'Rondônia'],
  ['RR', 'Roraima'],
  ['SC', 'Santa Catarina'],
  ['SP', 'São Paulo'],
  ['SE', 'Sergipe'],
  ['TO', 'Tocantins'],
] as const;
function stateCode(value: string | null) {
  const normalized = value?.trim().toLocaleLowerCase('pt-BR') ?? '';
  return (
    BRAZIL_STATES.find(
      ([code, name]) =>
        code.toLocaleLowerCase('pt-BR') === normalized ||
        name.toLocaleLowerCase('pt-BR') === normalized ||
        `${name} (${code})`.toLocaleLowerCase('pt-BR') === normalized,
    )?.[0] ?? null
  );
}
function stateLabel(value: string | null) {
  const code = stateCode(value);
  const found = BRAZIL_STATES.find(([item]) => item === code);
  return found ? `${found[1]} (${found[0]})` : (value ?? '');
}
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
  const [editing, setEditing] = useState<Machine | null>(null);
  const sites = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('pt-BR');
    return (data?.sites ?? []).filter(
      (site) =>
        (filter === 'all' || site.state === filter) &&
        (!q ||
          `${site.name} ${site.reference} ${site.machines.map((m) => `${m.deviceName} ${m.product ?? ''} ${m.location.city ?? ''}`).join(' ')}`
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
  const plants = useMemo(
    () => sites.flatMap((site) => site.machines.map((machine) => ({
      id: machine.deviceId,
      name: machine.deviceName,
      groupName: site.name,
      state: machine.state,
      location: machine.location,
    }))),
    [sites],
  );
  const select = useCallback((id: string) => {
    setSelected(id);
    document.getElementById(`machine-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        <div className="operations-content">
          <section className="operations-map-card">
            <header className="operations-section-head">
              <div className="operations-section-title">
                <span className="operations-section-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z" />
                    <circle cx="12" cy="10" r="2.5" />
                  </svg>
                </span>
                <div>
                  <h2>Mapa de operações</h2>
                  <p>Localização e condição atual das cerâmicas monitoradas.</p>
                </div>
              </div>
              <span className="operations-live">
                <i /> Ao vivo
              </span>
            </header>
            <div className="operations-map-frame">
              <PlantMap plants={plants} selected={selected} onSelect={select} />
              {plants.every((plant) => plant.location.latitude == null) && (
                <div className="operations-map-empty">
                  <span className="operations-section-icon" aria-hidden="true">
                    ⌖
                  </span>
                  <strong>Cadastre a localização das cerâmicas</strong>
                  <p>Use o botão Localização em cada unidade para exibir seus pontos no mapa.</p>
                </div>
              )}
            </div>
            <footer className="operations-map-foot">
              <div>
                <span className="operations-foot-label">Pontos exibidos</span>
                <strong>
                  {plants.filter((plant) => plant.location.latitude != null).length}{' '}
                  {plants.filter((plant) => plant.location.latitude != null).length === 1
                    ? 'cerâmica no mapa'
                    : 'cerâmicas no mapa'}
                </strong>
              </div>
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
            </footer>
            <div className="operations-location-chips">
              {plants
                .filter((plant) => plant.location.latitude != null)
                .map((plant) => (
                  <button key={plant.id} onClick={() => select(plant.id)}>
                    <i style={{ background: STATES[plant.state]?.color ?? STATES.unknown.color }} />
                    {plant.name}
                  </button>
                ))}
              {plants.some((plant) => plant.location.latitude == null) && (
                <span className="map-missing">
                  {plants.filter((plant) => plant.location.latitude == null).length} sem localização
                </span>
              )}
            </div>
          </section>
          <div className="operations-list-head">
            <div>
              <span className="eyebrow">VISÃO CONSOLIDADA</span>
              <h2>Produção por grupo e cerâmica</h2>
            </div>
            <span>{sites.length} unidades exibidas</span>
          </div>
          <section className="plant-list">
            {sites.map((site) => (
              <article
                id={`plant-${site.id}`}
                key={site.id}
                className={`plant-summary ${site.machines.some((machine) => machine.deviceId === selected) ? 'selected' : ''}`}
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
                    <small>GRUPO / CLIENTE</small>
                    <h2>{site.name}</h2>
                    <small>{site.reference}</small>
                  </div>
                </header>
                <div className="machine-grid">
                  {site.machines.map((machine) => (
                    <div className="machine-row" id={`machine-${machine.deviceId}`} key={machine.deviceId}>
                      <div className="machine-title">
                        <span>CERÂMICA</span>
                        <strong>{machine.deviceName}</strong>
                        <span>{[machine.location.city, machine.location.state].filter(Boolean).join(' · ') || machine.product || 'Localização não informada'}</span>
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
                      {user.role === 'master' && (
                        <button onClick={(event) => { event.stopPropagation(); setEditing(machine); }}>
                          Localização
                        </button>
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
          machine={editing}
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
  machine,
  onClose,
  onSaved,
}: {
  machine: Machine;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    address: machine.location.address ?? '',
    city: machine.location.city ?? '',
    state: stateLabel(machine.location.state),
    latitude: machine.location.latitude?.toString() ?? '',
    longitude: machine.location.longitude?.toString() ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [loadingCities, setLoadingCities] = useState(false);
  const selectedState = stateCode(form.state);
  useEffect(() => {
    if (!selectedState) {
      setCities([]);
      return;
    }
    const controller = new AbortController();
    setLoadingCities(true);
    void fetch(
      `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${selectedState}/municipios?orderBy=nome`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.ok) throw new Error('IBGE indisponível');
        return response.json() as Promise<Array<{ nome: string }>>;
      })
      .then((items) => setCities(items.map((item) => item.nome)))
      .catch((reason: unknown) => {
        if (!(reason instanceof Error && reason.name === 'AbortError')) setCities([]);
      })
      .finally(() => setLoadingCities(false));
    return () => controller.abort();
  }, [selectedState]);
  async function save() {
    setSaving(true);
    setError('');
    try {
      const region = stateCode(form.state);
      if (!region) throw new Error('Selecione um estado da lista.');
      const city = cities.find(
        (item) => item.toLocaleLowerCase('pt-BR') === form.city.trim().toLocaleLowerCase('pt-BR'),
      );
      if (!city) throw new Error('Selecione uma cidade válida da lista do IBGE.');
      const latitude = form.latitude.trim() === '' ? null : Number(form.latitude.replace(',', '.'));
      const longitude =
        form.longitude.trim() === '' ? null : Number(form.longitude.replace(',', '.'));
      if (
        (latitude === null) !== (longitude === null) ||
        (latitude !== null && !Number.isFinite(latitude)) ||
        (longitude !== null && !Number.isFinite(longitude))
      )
        throw new Error('Informe latitude e longitude válidas.');
      await mutate(`/devices/${machine.deviceId}/location`, 'PATCH', {
        ...form,
        city,
        state: region,
        latitude,
        longitude,
      });
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
            <h2>{machine.deviceName}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <p>
          Informe endereço, estado e cidade. A plataforma localizará a cerâmica automaticamente no mapa.
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
            Estado
            <input
              list={`states-${machine.deviceId}`}
              value={form.state}
              autoComplete="off"
              placeholder="Digite para buscar"
              onChange={(e) => setForm({ ...form, state: e.target.value, city: '' })}
            />
            <datalist id={`states-${machine.deviceId}`}>
              {BRAZIL_STATES.map(([code, name]) => (
                <option key={code} value={`${name} (${code})`} />
              ))}
            </datalist>
          </label>
          <label>
            Cidade
            <input
              list={`cities-${machine.deviceId}`}
              value={form.city}
              autoComplete="off"
              disabled={!selectedState || loadingCities}
              placeholder={
                loadingCities
                  ? 'Carregando cidades…'
                  : selectedState
                    ? 'Digite para buscar'
                    : 'Selecione o estado'
              }
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
            <datalist id={`cities-${machine.deviceId}`}>
              {cities.map((city) => (
                <option key={city} value={city} />
              ))}
            </datalist>
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
