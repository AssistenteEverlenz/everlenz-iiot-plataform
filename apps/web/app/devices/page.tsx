'use client';
import { useState } from 'react';
import { usePlatform } from '../../components/PlatformShell';
import { mutate, usePoll, type Device } from '../../components/data';
import { DevicesTable } from '../../components/DevicesTable';

interface Site {
  id: string;
  name: string;
  slug: string;
}
interface CreatedDevice {
  device: Device;
  connection: {
    host: string;
    port: number;
    tls: boolean;
    topic: string;
    suggestedUsername: string;
  };
}

export default function Devices() {
  const { user } = usePlatform();
  const [offset, setOffset] = useState(0);
  const devices = usePoll<Device[]>(`/devices?limit=50&offset=${offset}`);
  const sites = usePoll<Site[]>('/sites');
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedDevice | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    siteId: '',
    name: '',
    manufacturer: 'Haiwell',
    model: 'A7',
    serialNumber: '',
    adapterType: 'haiwell',
    topic: 'data/POC/group1/A7-002',
  });
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const result = await mutate<CreatedDevice>('/devices', 'POST', {
        ...form,
        siteId: form.siteId || sites.data?.[0]?.id,
        serialNumber: form.serialNumber || null,
      });
      setCreated(result);
      await devices.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao cadastrar');
    }
  }
  function close() {
    setOpen(false);
    setCreated(null);
    setError('');
  }
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
            <button className="primary-button" onClick={() => setOpen(true)}>
              ＋ Novo dispositivo
            </button>
          </div>
        )}
      </div>
      {devices.error && <div className="error-banner">{devices.error}</div>}
      <section className="card">
        <DevicesTable devices={devices.data} />
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
        <div className="modal-backdrop" onMouseDown={close}>
          <div className="modal-card wizard-modal" onMouseDown={(event) => event.stopPropagation()}>
            {created ? (
              <>
                <div className="success-mark">✓</div>
                <div className="eyebrow">IDENTIDADE RESERVADA</div>
                <h2>{created.device.name}</h2>
                <p>
                  O ativo recebeu um UUID interno imutável e um código curto para operação, suporte
                  e associação futura aos usuários.
                </p>
                <div className="commissioning-card">
                  <span>Código Everlenz</span>
                  <strong>{created.device.device_code}</strong>
                  <span>Broker TLS</span>
                  <code>
                    {created.connection.host}:{created.connection.port}
                  </code>
                  <span>Tópico</span>
                  <code>{created.connection.topic}</code>
                  <span>Usuário sugerido</span>
                  <code>{created.connection.suggestedUsername}</code>
                </div>
                <div className="notice">
                  <b>Próxima etapa operacional</b>A credencial individual precisa ser ativada no
                  broker antes da primeira conexão. Isso permanece controlado para não expor criação
                  de senhas MQTT na área pública.
                </div>
                <div className="modal-actions">
                  <button onClick={() => window.print()}>Imprimir ficha</button>
                  <button className="primary-button" onClick={close}>
                    Concluir
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={create}>
                <div className="modal-title">
                  <div>
                    <div className="eyebrow">COMISSIONAMENTO GUIADO</div>
                    <h2>Novo dispositivo</h2>
                  </div>
                  <button type="button" className="icon-button" onClick={close}>
                    ×
                  </button>
                </div>
                <div className="wizard-steps">
                  <span className="active">1 Identidade</span>
                  <span>2 MQTT</span>
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
                  <label className="field">
                    Fábrica / unidade
                    <select
                      value={form.siteId}
                      onChange={(event) => setForm({ ...form, siteId: event.target.value })}
                    >
                      {sites.data?.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Fabricante
                    <input
                      required
                      value={form.manufacturer}
                      onChange={(event) => setForm({ ...form, manufacturer: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    Modelo
                    <input
                      required
                      value={form.model}
                      onChange={(event) => setForm({ ...form, model: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    Número de série
                    <input
                      value={form.serialNumber}
                      onChange={(event) => setForm({ ...form, serialNumber: event.target.value })}
                      placeholder="Opcional"
                    />
                  </label>
                  <label className="field">
                    Formato dos dados
                    <select
                      value={form.adapterType}
                      onChange={(event) => setForm({ ...form, adapterType: event.target.value })}
                    >
                      <option value="haiwell">Haiwell</option>
                      <option value="generic">JSON Everlenz</option>
                    </select>
                  </label>
                  <label className="field full-field">
                    Tópico MQTT
                    <input
                      required
                      value={form.topic}
                      onChange={(event) => setForm({ ...form, topic: event.target.value })}
                    />
                    <small>Precisa ser exclusivo para este equipamento.</small>
                  </label>
                </div>
                <div className="setup-guide">
                  <div>
                    <span>01</span>
                    <b>Servidor</b>
                    <small>mqtt.everlenz.com.br · TLS 8883</small>
                  </div>
                  <div>
                    <span>02</span>
                    <b>Autenticação</b>
                    <small>Uma credencial exclusiva por ativo</small>
                  </div>
                  <div>
                    <span>03</span>
                    <b>Descoberta</b>
                    <small>As variáveis aparecem no botão ＋ do painel</small>
                  </div>
                </div>
                {error && <div className="form-error">{error}</div>}
                <div className="modal-actions">
                  <button type="button" onClick={close}>
                    Cancelar
                  </button>
                  <button className="primary-button" type="submit">
                    Criar identidade →
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
