'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePlatform } from '../../components/PlatformShell';
import { mutate, usePoll, type Device } from '../../components/data';
import { DevicesTable } from '../../components/DevicesTable';
import { ActionModal } from '../../components/ActionModal';

interface Site {
  id: string;
  name: string;
  slug: string;
  reference: string;
}
interface Connection {
  host: string;
  port: number;
  tls: boolean;
  topic: string;
  username: string;
  password?: string;
  clientReference: string;
  credentialActive?: boolean;
}
interface CreatedDevice {
  device: Device;
  connection: Connection;
}
const models = {
  Haiwell: ['A7', 'A7 Pro', 'A10', 'A10 Pro', 'A15', 'A15 Pro'],
  Weintek: [
    'cMT2078X',
    'cMT2108X2',
    'cMT2158X',
    'cMT2166X',
    'cMT3072XP',
    'cMT3092X',
    'cMT3102X',
    'cMT3108XH',
    'cMT3152X',
    'cMT3162X',
    'cMT-FHDX-820',
    'cMT-SVRX-820',
  ],
  Delta: ['DOP-3S07S3E2', 'DOP-3S10S3E2'],
} as const;
type Manufacturer = keyof typeof models;

export default function Devices() {
  const { user } = usePlatform();
  const [offset, setOffset] = useState(0);
  const devices = usePoll<Device[]>(`/devices?limit=50&offset=${offset}`);
  const sites = usePoll<Site[]>('/sites');
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedDevice | null>(null);
  const [selected, setSelected] = useState<Device | null>(null);
  const [siteSearch, setSiteSearch] = useState('');
  const [addingSite, setAddingSite] = useState(false);
  const [siteForm, setSiteForm] = useState({ name: '', reference: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [siteSaving, setSiteSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    siteId: '',
    name: '',
    manufacturer: 'Haiwell' as Manufacturer,
    model: 'A7',
    serialNumber: '',
  });
  const filteredSites = useMemo(
    () =>
      (sites.data ?? []).filter((site) =>
        `${site.name} ${site.reference}`.toLowerCase().includes(siteSearch.toLowerCase()),
      ),
    [sites.data, siteSearch],
  );
  useEffect(() => {
    if (!form.siteId && sites.data?.[0])
      setForm((current) => ({ ...current, siteId: sites.data![0].id }));
  }, [sites.data, form.siteId]);

  function changeManufacturer(manufacturer: Manufacturer) {
    setForm({ ...form, manufacturer, model: models[manufacturer][0] });
  }
  async function createSite() {
    setSiteSaving(true);
    setError('');
    try {
      const site = await mutate<Site>('/sites', 'POST', siteForm);
      await sites.refresh();
      setForm({ ...form, siteId: site.id });
      setSiteSearch(site.name);
      setAddingSite(false);
      setSiteForm({ name: '', reference: '' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao cadastrar cliente.');
    } finally {
      setSiteSaving(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const result = await mutate<CreatedDevice>('/devices', 'POST', {
        ...form,
        serialNumber: form.serialNumber || null,
      });
      setCreated(result);
      await devices.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao cadastrar equipamento.');
    } finally {
      setSaving(false);
    }
  }
  function close() {
    setOpen(false);
    setCreated(null);
    setSelected(null);
    setError('');
  }
  function selectDevice(device: Device) {
    setSelected(device);
    setForm({
      siteId: device.site_id,
      name: device.name,
      manufacturer: device.manufacturer as Manufacturer,
      model: device.model,
      serialNumber: device.serial_number ?? '',
    });
    setOpen(true);
  }
  async function saveDevice(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await mutate(`/devices/${selected.id}`, 'PATCH', {
        ...form,
        serialNumber: form.serialNumber || null,
      });
      await devices.refresh();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar equipamento.');
    } finally {
      setSaving(false);
    }
  }
  async function deleteDevice() {
    if (!selected) return;
    await mutate(`/devices/${selected.id}`, 'DELETE');
    await devices.refresh();
    close();
  }
  const connection =
    created?.connection ??
    (selected
      ? {
          host: 'mqtt.everlenz.com.br',
          port: 8883,
          tls: true,
          topic: selected.mqtt_topic ?? '—',
          username: selected.mqtt_username ?? selected.device_code.toLowerCase(),
          password: selected.mqtt_password,
          clientReference: selected.site_reference ?? '—',
        }
      : null);

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">ATIVOS INDUSTRIAIS</div>
          <h1>Dispositivos</h1>
          <p>Inventário, identidade única e conectividade dos equipamentos.</p>
        </div>
        {user.role === 'master' && (
          <div className="toolbar-actions">
            <button
              className="primary-button"
              onClick={() => {
                setForm({
                  siteId: sites.data?.[0]?.id ?? '',
                  name: '',
                  manufacturer: 'Haiwell',
                  model: 'A7',
                  serialNumber: '',
                });
                setOpen(true);
              }}
            >
              ＋ Novo dispositivo
            </button>
          </div>
        )}
      </div>
      {devices.error && <div className="error-banner">{devices.error}</div>}
      <section className="card">
        <DevicesTable
          devices={devices.data}
          onSelect={user.role === 'master' ? selectDevice : undefined}
        />
        <div className="pager">
          <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
            Anterior
          </button>
          <span>Página {offset / 50 + 1}</span>
          <button
            disabled={!devices.data || devices.data.length < 50}
            onClick={() => setOffset(offset + 50)}
          >
            Próxima
          </button>
        </div>
      </section>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => !saving && close()}>
          <div className="modal-card wizard-modal" onMouseDown={(event) => event.stopPropagation()}>
            {created ? (
              <CredentialCard created={created} onClose={close} />
            ) : (
              <form onSubmit={selected ? saveDevice : create}>
                <div className="modal-title">
                  <div>
                    <div className="eyebrow">
                      {selected ? 'EQUIPAMENTO CADASTRADO' : 'COMISSIONAMENTO GUIADO'}
                    </div>
                    <h2>{selected ? selected.name : 'Novo dispositivo'}</h2>
                  </div>
                  <button type="button" disabled={saving} className="icon-button" onClick={close}>
                    ×
                  </button>
                </div>
                {selected && connection && (
                  <ConnectionCard connection={connection} deviceCode={selected.device_code} />
                )}
                <div className="wizard-steps">
                  <span className="active">1 Cliente</span>
                  <span className="active">2 Equipamento</span>
                  <span>3 Conectar</span>
                </div>
                <div className="form-grid">
                  <label className="field full-field">
                    Nome do equipamento
                    <input
                      required
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      placeholder="Ex.: Forno túnel 01"
                    />
                  </label>
                  <div className="field full-field">
                    Cliente / fábrica / unidade
                    <input
                      type="search"
                      value={siteSearch}
                      onChange={(event) => setSiteSearch(event.target.value)}
                      placeholder="Busque por nome ou referência…"
                    />
                    <div className="site-picker">
                      {filteredSites.map((site) => (
                        <button
                          type="button"
                          key={site.id}
                          className={form.siteId === site.id ? 'selected' : ''}
                          onClick={() => {
                            setForm({ ...form, siteId: site.id });
                            setSiteSearch(site.name);
                          }}
                        >
                          {site.name}
                          <small>{site.reference}</small>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="add-site"
                        onClick={() => setAddingSite(!addingSite)}
                      >
                        ＋ Novo cliente/unidade
                      </button>
                    </div>
                  </div>
                  {addingSite && (
                    <div className="inline-site-form full-field">
                      <label className="field">
                        Nome
                        <input
                          value={siteForm.name}
                          onChange={(event) =>
                            setSiteForm({ ...siteForm, name: event.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        Referência do cliente
                        <input
                          value={siteForm.reference}
                          onChange={(event) =>
                            setSiteForm({
                              ...siteForm,
                              reference: event.target.value.toUpperCase(),
                            })
                          }
                          placeholder="Ex.: CER-ABC"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={siteSaving}
                        className="primary-button"
                        onClick={() => void createSite()}
                      >
                        {siteSaving && <span className="button-spinner" />}
                        {siteSaving ? 'Cadastrando…' : 'Cadastrar cliente'}
                      </button>
                    </div>
                  )}
                  <label className="field">
                    Fabricante
                    <select
                      value={form.manufacturer}
                      onChange={(event) => changeManufacturer(event.target.value as Manufacturer)}
                    >
                      {Object.keys(models).map((manufacturer) => (
                        <option key={manufacturer}>{manufacturer}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Modelo
                    <select
                      value={form.model}
                      onChange={(event) => setForm({ ...form, model: event.target.value })}
                    >
                      {models[form.manufacturer].map((model) => (
                        <option key={model}>{model}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field full-field">
                    Número de série
                    <input
                      value={form.serialNumber}
                      onChange={(event) => setForm({ ...form, serialNumber: event.target.value })}
                      placeholder="Opcional"
                    />
                  </label>
                </div>
                <div className="notice">
                  <b>Tópico gerado automaticamente</b>O sistema cria um tópico MQTT exclusivo usando
                  o cliente, o equipamento e o código Everlenz.
                </div>
                {error && <div className="form-error">{error}</div>}
                <div className="modal-actions">
                  {selected && (
                    <button
                      type="button"
                      disabled={saving}
                      className="danger-text"
                      onClick={() => setConfirmDelete(true)}
                    >
                      Excluir equipamento
                    </button>
                  )}
                  <button type="button" disabled={saving} onClick={close}>
                    Cancelar
                  </button>
                  <button className="primary-button" disabled={saving}>
                    {saving && <span className="button-spinner" />}
                    {saving
                      ? 'Processando…'
                      : selected
                        ? 'Salvar alterações'
                        : 'Criar identidade →'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {confirmDelete && selected && (
        <ActionModal
          title="Excluir equipamento"
          description={`O equipamento “${selected.name}” será desativado e suas credenciais MQTT serão revogadas.`}
          confirmLabel="Excluir equipamento"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={deleteDevice}
        />
      )}
    </>
  );
}

function ConnectionCard({
  connection,
  deviceCode,
}: {
  connection: Connection;
  deviceCode: string;
}) {
  return (
    <div className="commissioning-card compact-credentials">
      <span>Referência do cliente</span>
      <strong>{connection.clientReference}</strong>
      <span>Código Everlenz</span>
      <strong>{deviceCode}</strong>
      <span>Broker TLS</span>
      <code>
        {connection.host}:{connection.port}
      </code>
      <span>Tópico</span>
      <code>{connection.topic}</code>
      <span>User name</span>
      <code>{connection.username}</code>
      <span>Password</span>
      <code>{connection.password ?? 'Disponível após ativar a credencial MQTT'}</code>
    </div>
  );
}
function CredentialCard({ created, onClose }: { created: CreatedDevice; onClose: () => void }) {
  return (
    <>
      <div className="success-mark">✓</div>
      <div className="eyebrow">IDENTIDADE E CREDENCIAL CRIADAS</div>
      <h2>{created.device.name}</h2>
      <p>
        Use estes dados no campo User info da IHM. Eles continuam disponíveis ao abrir o
        equipamento.
      </p>
      <ConnectionCard connection={created.connection} deviceCode={created.device.device_code} />
      {created.connection.credentialActive === false && (
        <div className="notice">
          <b>Ativação do broker pendente</b>A identidade foi salva, mas o broker ainda não confirmou
          a credencial. Abra novamente o equipamento após o serviço sincronizar.
        </div>
      )}
      <div className="modal-actions">
        <button onClick={() => window.print()}>Imprimir ficha</button>
        <button className="primary-button" onClick={onClose}>
          Concluir
        </button>
      </div>
    </>
  );
}
