'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlantMap } from '../../components/PlantMap';
import { duration, ShiftBoard } from '../../components/ShiftBoard';
import {
  normalizeCard,
  OperationCardBody,
  OperationCardEditor,
  cardFromModel,
  type CardConfig,
  healthOf,
  HEALTH_LABELS,
} from '../../components/OperationCard';
import type { PanelSource } from '../../components/variables';
import { NavIcon } from '../../components/NavIcon';
import { WearModal } from '../../components/WearModal';
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
  /** When the machine entered the state it is in now; absent when it cannot be known. */
  stateSince: string | null;
  product: string | null;
  updatedAt: string | null;
  metric: 'milheiros' | 'tons' | 'blocks' | 'pallets';
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  target: number | null;
  projection: number;
  pacePerHour: number;
  utilization: number | null;
  location: Location;
  readings: Record<string, number>;
  texts?: Record<string, string>;
  board: PanelSource | null;
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
type OperationSettings = {
  layoutColumns: 1 | 2 | 3;
  /** The card the group keeps as its model, or null while it has not chosen one. */
  defaultCard: CardConfig | null;
  cards: Record<string, unknown>;
};
const STATES: Record<string, { label: string; color: string }> = {
  producing: { label: 'Produzindo', color: '#1fbf7a' },
  idle: { label: 'Ociosa', color: '#f2a93b' },
  manual: { label: 'Manual / parada', color: '#e4572e' },
  pause: { label: 'Pausa', color: '#cdb9ea' },
  offline: { label: 'Sem comunicação', color: '#98a6ab' },
  unknown: { label: 'Sem dados', color: '#98a6ab' },
};
/**
 * The machine state in words, with how long it has been in it. It is deliberately wordy and
 * uncoloured: colour on the card belongs to the target, and a plant can be on target and stopped
 * this very minute. Nothing is said when the card already reports no communication.
 */
function stateLine(machine: Machine) {
  if (machine.state === 'offline' || machine.state === 'unknown') return null;
  const label = STATES[machine.state]?.label;
  if (!label) return null;
  const since = machine.stateSince ? Date.parse(machine.stateSince) : NaN;
  const seconds = Number.isNaN(since) ? 0 : (Date.now() - since) / 1000;
  return seconds >= 60 ? `${label} há ${duration(seconds)}` : label;
}

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

export default function OperationsPage() {
  const { user } = usePlatform();
  const { data, error, loading, refresh } = usePoll<Overview>('/operations/overview', 5000);
  const settings = usePoll<OperationSettings>('/operations/settings', 30000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Machine | null>(null);
  const [wear, setWear] = useState<Machine | null>(null);
  const [detail, setDetail] = useState<Machine | null>(null);
  const [configuring, setConfiguring] = useState<{ machine: Machine; siteName: string; width: number | null } | null>(null);
  // The editor draws the card at the width it has in the list, so it wraps the same way there.
  const configure = useCallback((machine: Machine, siteName: string) => {
    const card = document.getElementById(`machine-${machine.deviceId}`)?.closest('.plant-summary');
    setConfiguring({ machine, siteName, width: card instanceof HTMLElement ? card.offsetWidth : null });
  }, []);
  const [layoutColumns, setLayoutColumns] = useState<1 | 2 | 3>(2);
  useEffect(() => { if (settings.data?.layoutColumns) setLayoutColumns(settings.data.layoutColumns); }, [settings.data?.layoutColumns]);
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
  const clearSelection = useCallback(() => setSelected(null), []);
  const placeOf = useCallback(
    (machine: Machine) =>
      [machine.location.city, machine.location.state].filter(Boolean).join(' · ') ||
      machine.product ||
      '',
    [],
  );
  const cardActions = useCallback(
    (machine: Machine, siteName: string) => (
      <>
        {user.role === 'master' && (
          <button
            title="Editar cartão"
            aria-label="Editar cartão"
            onClick={() => configure(machine, siteName)}
          >
            <NavIcon name="edit" />
          </button>
        )}
        <button
          title="Relatório de produção"
          aria-label="Relatório de produção"
          onClick={() => setDetail(machine)}
        >
          <NavIcon name="report" />
        </button>
        <button
          title="Desgaste da linha"
          aria-label="Desgaste da linha"
          onClick={() => setWear(machine)}
        >
          <NavIcon name="gauge" />
        </button>
        {machine.dashboardId && (
          <Link
            title="Abrir painel"
            aria-label="Abrir painel"
            href={`/dashboards/${machine.dashboardId}`}
          >
            <NavIcon name="panels" />
          </Link>
        )}
        {user.role === 'master' && (
          <button
            title="Editar localização"
            aria-label="Editar localização"
            onClick={() => setEditing(machine)}
          >
            <NavIcon name="pin" />
          </button>
        )}
      </>
    ),
    [configure, user.role],
  );
  // A plant that has never had its card arranged starts from the group's model, when the group
  // has chosen one, instead of the built-in layout.
  const configFor = useCallback(
    (machine: Machine): CardConfig => {
      const stored = settings.data?.cards[machine.deviceId];
      const model = settings.data?.defaultCard;
      if (!stored && model) return cardFromModel(model, machine.metric);
      return normalizeCard(stored, machine.metric);
    },
    [settings.data],
  );
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
              <PlantMap plants={plants} selected={selected} onSelect={select} onClear={clearSelection} />
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
            <div className="operations-layout-control">
              <span>{sites.length} unidades exibidas</span>
              {/* Every plant on a wall display at once, and its editor for the master. */}
              <a className="operations-tv-link" href="/operations/tv" target="_blank" rel="noreferrer">
                <NavIcon name="tv" /> Modo TV
              </a>
              {user.role === 'master' && (
                <Link className="operations-tv-link" href="/operations/tv/editor">
                  Configurar TV
                </Link>
              )}
              {user.role === 'master' && <label>Distribuição
                <select value={layoutColumns} onChange={async (event) => { const next = Number(event.target.value) as 1 | 2 | 3; setLayoutColumns(next); try { await mutate('/operations/settings', 'PATCH', { layoutColumns: next }); await settings.refresh(); } catch { setLayoutColumns(settings.data?.layoutColumns ?? 2); } }}>
                  <option value="1">1 por linha</option><option value="2">2 colunas</option><option value="3">3 colunas</option>
                </select>
              </label>}
            </div>
          </div>
          <section className={`plant-list columns-${layoutColumns}`} onClick={() => setSelected(null)}>
            {sites.map((site) => {
              // A card that holds a single machine speaks as that machine.
              const only = site.machines.length === 1 ? site.machines[0] : null;
              return (
              <article
                id={`plant-${site.id}`}
                key={site.id}
                className={`plant-summary ${site.machines.some((machine) => machine.deviceId === selected) ? 'selected' : ''}`}
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <div className="plant-heading">
                    {/* One machine, the usual case: its own name leads and the group follows it.
                        A group with several machines leads with the group, and each row names
                        the machine it draws. */}
                    <h2>
                      {only ? only.deviceName : site.name}
                      {/* A one-machine group is often named after the machine: saying it twice
                          adds nothing. */}
                      {only && site.name !== only.deviceName && (
                        <span className="plant-group">{site.name}</span>
                      )}
                    </h2>
                    {/* The live state rides with the place, under the name: the footer already
                        carries the target and the last signal, and a third item crowded it. */}
                    {only && (placeOf(only) || stateLine(only)) && (
                      <small>
                        {placeOf(only)}
                        {stateLine(only) && (
                          <span
                            className="machine-state"
                            style={{ '--state': STATES[only.state]?.color } as React.CSSProperties}
                          >
                            <i />
                            {stateLine(only)}
                          </span>
                        )}
                      </small>
                    )}
                  </div>
                  {only && (
                    <div className="plant-card-actions">{cardActions(only, site.name)}</div>
                  )}
                </header>
                <div className="machine-grid">
                  {site.machines.map((machine) => (
                    <div className="machine-slot" id={`machine-${machine.deviceId}`} key={machine.deviceId}>
                      <OperationCardBody
                        machine={machine}
                        config={configFor(machine)}
                        heading={
                          only ? null : (
                            <div className="machine-line">
                              <strong>{machine.deviceName}</strong>
                              {placeOf(machine) && <small>{placeOf(machine)}</small>}
                              {stateLine(machine) && (
                                <span
                                  className="machine-state"
                                  style={{ '--state': STATES[machine.state]?.color } as React.CSSProperties}
                                >
                                  <i />
                                  {stateLine(machine)}
                                </span>
                              )}
                              <em className="machine-health">
                                <i />
                                {HEALTH_LABELS[healthOf(machine, configFor(machine))]}
                              </em>
                              <div className="plant-card-actions">
                                {cardActions(machine, site.name)}
                              </div>
                            </div>
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <footer>
                  {only && (
                    <>
                      <em className="machine-health">
                        <i />
                        {HEALTH_LABELS[healthOf(only, configFor(only))]}
                      </em>
                      {' · '}
                    </>
                  )}
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
              );
            })}
            {sites.length === 0 && (
              <div className="empty">Nenhuma cerâmica corresponde aos filtros.</div>
            )}
          </section>
        </div>
      )}
      {wear && (
        <WearModal
          deviceId={wear.deviceId}
          deviceName={wear.deviceName}
          onClose={() => setWear(null)}
        />
      )}
      {editing && (
        <LocationModal
          machine={editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
          onChanged={() => refresh()}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {detail && (
        <div className="modal-backdrop operations-report-backdrop" onMouseDown={() => setDetail(null)}>
          <section className="modal-card operations-report-modal" onMouseDown={(event) => event.stopPropagation()}>
            <header className="operations-report-head">
              <div><span className="eyebrow">RELATÓRIO DE PRODUÇÃO</span><h2>{detail.deviceName}</h2><small>{detail.siteName}</small></div>
              <button className="icon-button" onClick={() => setDetail(null)}>×</button>
            </header>
            <ShiftBoard deviceId={detail.deviceId} />
          </section>
        </div>
      )}
      {configuring && (
        <OperationCardEditor
          machine={configuring.machine}
          siteName={configuring.siteName}
          width={configuring.width}
          initial={configFor(configuring.machine)}
          groupDefault={settings.data?.defaultCard ?? null}
          onClose={() => setConfiguring(null)}
          onSaved={async () => {
            setConfiguring(null);
            await settings.refresh();
          }}
        />
      )}
    </div>
  );
}
function LocationModal({
  machine,
  onClose,
  onSaved,
  onChanged,
}: {
  machine: Machine;
  onClose: () => void;
  onSaved: () => void;
  /** The point was saved but the modal stays open: refresh the map behind it. */
  onChanged: () => Promise<void> | void;
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
  const [notice, setNotice] = useState('');
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
    setNotice('');
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
      const saved = await mutate<{
        precision: 'exact' | 'address' | 'city' | null;
        latitude: number | null;
        longitude: number | null;
      }>(`/devices/${machine.deviceId}/location`, 'PATCH', {
        ...form,
        city,
        state: region,
        latitude,
        longitude,
      });
      // A ceramic on a rural road is placed on its town: say so and offer the exact point,
      // instead of closing as if the address itself had been found.
      if (saved.precision === 'city') {
        setForm((current) => ({
          ...current,
          latitude: saved.latitude?.toString() ?? '',
          longitude: saved.longitude?.toString() ?? '',
        }));
        setNotice(
          `O endereço exato não está no mapa, então a cerâmica foi marcada no centro de ${city}. Para o ponto exato, informe latitude e longitude e salve de novo.`,
        );
        void onChanged();
        return;
      }
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
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>{notice ? 'Fechar' : 'Cancelar'}</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Salvando…' : 'Salvar localização'}
          </button>
        </div>
      </div>
    </div>
  );
}
