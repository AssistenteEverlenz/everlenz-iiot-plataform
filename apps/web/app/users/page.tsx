'use client';

import { useMemo, useState } from 'react';
import { mutate, time, usePoll, type Device } from '../../components/data';
import { ActionModal } from '../../components/ActionModal';
import Link from 'next/link';
import { ModalPortal } from '../../components/ModalPortal';
import { UserUsageModal } from '../../components/UsageViews';

interface ManagedUser {
  id: string;
  email: string;
  full_name: string;
  role: 'master' | 'user';
  status: 'active' | 'inactive';
  must_change_password: boolean;
  can_log_measurements: boolean;
  last_login_at: string | null;
  device_ids: string[];
  phone?: string | null;
  whatsapp_daily?: boolean;
}

/** "5527999998888" as "(27) 99999-8888". */
function phoneLabel(phone: string | null | undefined) {
  const digits = String(phone ?? '').replace(/\D/g, '').replace(/^55/, '');
  if (digits.length < 10) return phone ?? '';
  const local = digits.slice(2);
  return `(${digits.slice(0, 2)}) ${local.slice(0, local.length - 4)}-${local.slice(-4)}`;
}

interface UserForm {
  fullName: string;
  email: string;
  status: 'active' | 'inactive';
  deviceIds: string[];
  canLogMeasurements: boolean;
  phone: string;
  whatsappDaily: boolean;
}

const emptyForm: UserForm = {
  fullName: '',
  email: '',
  status: 'active',
  deviceIds: [],
  canLogMeasurements: false,
  phone: '',
  whatsappDaily: false,
};

export default function UsersPage() {
  const users = usePoll<ManagedUser[]>('/users', 10000);
  const devices = usePoll<Device[]>('/devices?limit=500', 10000);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    type: 'toggle' | 'remove' | 'reset';
    user: ManagedUser;
  } | null>(null);
  const [query, setQuery] = useState('');
  // Whose use of the platform is open, and over how many days.
  const [usageOf, setUsageOf] = useState<string | null>(null);
  const [usageDays, setUsageDays] = useState(30);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'pending'>('all');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [ceramicQuery, setCeramicQuery] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const filteredUsers = useMemo(() => (users.data ?? []).filter((user) => {
    const q = query.trim().toLocaleLowerCase('pt-BR');
    const accessible = user.role === 'master' ? (devices.data ?? []) : (devices.data ?? []).filter((device) => user.device_ids.includes(device.id));
    return (!q || `${user.full_name} ${user.email} ${accessible.map((device) => `${device.name} ${device.site_name ?? ''}`).join(' ')}`.toLocaleLowerCase('pt-BR').includes(q))
      && (!deviceFilter || user.role === 'master' || user.device_ids.includes(deviceFilter))
      && (statusFilter === 'all' || (statusFilter === 'pending' ? user.must_change_password : user.status === statusFilter));
  }), [users.data, devices.data, query, deviceFilter, statusFilter]);
  const visibleDevices = useMemo(() => (devices.data ?? []).filter((device) =>
    `${device.name} ${device.device_code} ${device.site_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(deviceSearch.toLocaleLowerCase('pt-BR'))
  ), [devices.data, deviceSearch]);

  function createUser() {
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setOpen(true);
  }

  function editUser(user: ManagedUser) {
    setEditing(user);
    setForm({
      fullName: user.full_name,
      email: user.email,
      status: user.status,
      deviceIds: user.device_ids,
      canLogMeasurements: user.can_log_measurements,
      phone: phoneLabel(user.phone),
      whatsappDaily: Boolean(user.whatsapp_daily),
    });
    setError('');
    setOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // An empty phone is sent as null: it removes the phone and turns the summary off.
      const payload = { ...form, phone: form.phone.trim() || null };
      if (editing) await mutate(`/users/${editing.id}`, 'PATCH', payload);
      else {
        const result = await mutate<{ temporaryPassword: string }>('/users', 'POST', payload);
        setCredential({ email: form.email, password: result.temporaryPassword });
      }
      setOpen(false);
      await users.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar o usuário.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(user: ManagedUser) {
    await mutate(`/users/${user.id}`, 'PATCH', {
      status: user.status === 'active' ? 'inactive' : 'active',
    });
    await users.refresh();
  }

  async function remove(user: ManagedUser) {
    await mutate(`/users/${user.id}`, 'DELETE');
    await users.refresh();
  }

  async function reset(user: ManagedUser) {
    const result = await mutate<{ temporaryPassword: string }>(
      `/users/${user.id}/reset-password`,
      'POST',
    );
    setCredential({ email: user.email, password: result.temporaryPassword });
    await users.refresh();
  }

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">ADMINISTRAÇÃO MASTER</div>
          <h1>Usuários e acessos</h1>
          <p>Defina quem entra na plataforma e quais equipamentos cada pessoa pode consultar.</p>
        </div>
        <div className="heading-actions">
          <Link className="secondary-button" href="/users/usage">
            Uso da plataforma
          </Link>
          <button className="primary-button" onClick={createUser}>
            ＋ Novo usuário
          </button>
        </div>
      </div>
      {users.error && <div className="error-banner">{users.error}</div>}
      <section className="user-summary-grid">
        <button className="card" onClick={() => setStatusFilter('all')}>
          <span>USUÁRIOS</span>
          <strong>{users.data?.length ?? '—'}</strong>
          <small>incluindo sua conta master</small>
        </button>
        <button className="card" onClick={() => setStatusFilter('active')}>
          <span>ATIVOS</span>
          <strong>{users.data?.filter((user) => user.status === 'active').length ?? '—'}</strong>
          <small>com acesso liberado</small>
        </button>
        <button className="card" onClick={() => setStatusFilter('pending')}>
          <span>AGUARDANDO TROCA</span>
          <strong>{users.data?.filter((user) => user.must_change_password).length ?? '—'}</strong>
          <small>usando senha provisória</small>
        </button>
      </section>
      <section className="card users-filter-bar">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome, e-mail, grupo ou cerâmica" />
        <div className="filter-combobox">
          <input
            type="search"
            list="user-ceramic-filter"
            value={ceramicQuery}
            onChange={(event) => {
              const value = event.target.value;
              setCeramicQuery(value);
              const match = (devices.data ?? []).find((device) => `${device.name} · ${device.site_name ?? ''}` === value);
              setDeviceFilter(match?.id ?? '');
            }}
            placeholder="Todas as cerâmicas · digite para buscar"
          />
          <datalist id="user-ceramic-filter">
            {(devices.data ?? []).map((device) => <option key={device.id} value={`${device.name} · ${device.site_name ?? ''}`} />)}
          </datalist>
        </div>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
          <option value="all">Todos os status</option><option value="active">Ativos</option><option value="inactive">Desativados</option><option value="pending">Troca pendente</option>
        </select>
      </section>
      <section className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Perfil</th>
              <th>Equipamentos</th>
              <th>Último acesso</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((user) => (
              // The whole row opens the person: their use of the platform and, for a client, what
              // can be done to the account. Four buttons per row made the table too wide to read
              // on a phone.
              <tr
                key={user.id}
                className="user-row"
                tabIndex={0}
                title="Abrir usuário"
                onClick={() => setUsageOf(user.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setUsageOf(user.id);
                  }
                }}
              >
                <td data-label="Usuário">
                  <strong>{user.full_name}</strong>
                  <small>{user.email}</small>
                </td>
                <td data-label="Perfil">
                  <span className={`role-badge ${user.role}`}>
                    {user.role === 'master' ? 'MASTER' : 'CLIENTE'}
                  </span>
                </td>
                <td data-label="Equipamentos">
                  {user.role === 'master' ? 'Todos' : `${user.device_ids.length} liberado(s)`}
                </td>
                <td data-label="Último acesso">{time(user.last_login_at)}</td>
                <td data-label="Status">
                  <span className={`badge ${user.status === 'active' ? '' : 'offline'}`}>
                    {user.status === 'active' ? 'Ativo' : 'Desativado'}
                  </span>
                  {user.must_change_password && <small>Troca de senha pendente</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {usageOf && (
        <ModalPortal>
          <UserUsageModal
            userId={usageOf}
            days={usageDays}
            onDays={setUsageDays}
            onClose={() => setUsageOf(null)}
            actions={(() => {
              // A master account is not edited from here: only a client's.
              const user = users.data?.find((item) => item.id === usageOf);
              if (!user || user.role !== 'user') return null;
              // The confirmation and the form open on their own, over the list.
              const then = (action: () => void) => () => {
                setUsageOf(null);
                action();
              };
              return (
                <>
                  <button type="button" onClick={then(() => editUser(user))}>
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={then(() => setPendingAction({ type: 'toggle', user }))}
                  >
                    {user.status === 'active' ? 'Desativar' : 'Ativar'}
                  </button>
                  <button
                    type="button"
                    onClick={then(() => setPendingAction({ type: 'reset', user }))}
                  >
                    Nova senha
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    onClick={then(() => setPendingAction({ type: 'remove', user }))}
                  >
                    Excluir
                  </button>
                  {user.phone && (
                    <button
                      type="button"
                      title={`Enfileira o resumo de hoje até agora para ${phoneLabel(user.phone)}`}
                      onClick={async () => {
                        try {
                          await mutate(`/users/${user.id}/whatsapp-test`, 'POST');
                          window.alert(
                            'Teste na fila. O n8n envia na próxima rodada (entre 07h e 21h, com intervalo mínimo de 3 min entre mensagens).',
                          );
                        } catch (reason) {
                          window.alert(reason instanceof Error ? reason.message : 'Não foi possível enviar o teste.');
                        }
                      }}
                    >
                      Enviar teste no WhatsApp
                    </button>
                  )}
                </>
              );
            })()}
          />
        </ModalPortal>
      )}
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <form
            className="modal-card user-modal"
            onSubmit={save}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">CONTROLE DE ACESSO</div>
                <h2>{editing ? 'Editar usuário' : 'Cadastrar usuário'}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <div className="form-grid">
              <label className="field">
                Nome completo
                <input
                  required
                  minLength={2}
                  value={form.fullName}
                  onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                />
              </label>
              <label className="field">
                E-mail
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </label>
              <label className="field">
                Status
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as 'active' | 'inactive' })
                  }
                >
                  <option value="active">Ativo</option>
                  <option value="inactive">Desativado</option>
                </select>
              </label>
            </div>
            <div className="user-whatsapp">
              <label className="field">
                WhatsApp
                <input
                  type="tel"
                  inputMode="tel"
                  value={form.phone}
                  placeholder="(27) 99999-8888"
                  onChange={(event) =>
                    setForm({
                      ...form,
                      phone: event.target.value,
                      whatsappDaily: event.target.value.trim() ? form.whatsappDaily : false,
                    })
                  }
                />
              </label>
              <label className="user-measure-permission">
                <input
                  type="checkbox"
                  checked={form.whatsappDaily}
                  disabled={!form.phone.trim()}
                  onChange={(event) => setForm({ ...form, whatsappDaily: event.target.checked })}
                />
                <span>
                  <strong>Receber o resumo diário de produção no WhatsApp</strong>
                  <small>
                    Enviado quando o dia de produção fecha (com a hora extra incluída), entre 07h e
                    21h, com os equipamentos que esta pessoa acessa.
                  </small>
                </span>
              </label>
            </div>
            <label className="user-measure-permission">
              <input
                type="checkbox"
                checked={form.canLogMeasurements}
                onChange={(event) => setForm({ ...form, canLogMeasurements: event.target.checked })}
              />
              <span>
                <strong>Pode lançar o peso do tijolo e manutenções</strong>
                <small>
                  Esses lançamentos embasam decisão de manutenção e ficam com o nome de quem
                  lançou. Sem isto, o usuário apenas visualiza.
                </small>
              </span>
            </label>
            <div className="device-access-box">
              <div>
                <strong>Equipamentos liberados</strong>
                <small>O usuário verá somente os dados selecionados.</small>
              </div>
              <input type="search" value={deviceSearch} onChange={(event) => setDeviceSearch(event.target.value)} placeholder="Buscar grupo, cerâmica ou código" />
              <small>{form.deviceIds.length} selecionado(s) · {visibleDevices.length} exibido(s)</small>
              <div className="device-check-grid scalable-device-picker">
                {visibleDevices.map((device) => (
                  <label key={device.id}>
                    <input
                      type="checkbox"
                      checked={form.deviceIds.includes(device.id)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          deviceIds: event.target.checked
                            ? [...form.deviceIds, device.id]
                            : form.deviceIds.filter((id) => id !== device.id),
                        })
                      }
                    />
                    <span>
                      <strong>{device.name}</strong>
                      <small>{device.site_name} · {device.device_code}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
                Cancelar
              </button>
              <button className="primary-button" disabled={saving}>
                {saving && <span className="button-spinner" />}
                {saving ? 'Salvando...' : 'Salvar usuário'}
              </button>
            </div>
          </form>
        </div>
      )}
      {credential && (
        <div className="modal-backdrop">
          <section className="modal-card compact-modal credential-modal">
            <div className="modal-security-icon">✓</div>
            <div className="eyebrow">ACESSO CRIADO</div>
            <h2>Envie estas credenciais</h2>
            <p>A senha aparece apenas agora e deverá ser trocada no primeiro acesso.</p>
            <div className="credential-box">
              <span>LOGIN</span>
              <code>{credential.email}</code>
              <span>SENHA PROVISÓRIA</span>
              <code>{credential.password}</code>
            </div>
            <button
              className="secondary-button"
              onClick={() =>
                void navigator.clipboard.writeText(
                  `Login: ${credential.email}\nSenha provisória: ${credential.password}`,
                )
              }
            >
              Copiar credenciais
            </button>
            <button className="primary-button" onClick={() => setCredential(null)}>
              Concluir
            </button>
          </section>
        </div>
      )}
      {pendingAction && (
        <ActionModal
          title={
            pendingAction.type === 'remove'
              ? 'Excluir usuário'
              : pendingAction.type === 'reset'
                ? 'Gerar nova senha'
                : pendingAction.user.status === 'active'
                  ? 'Desativar usuário'
                  : 'Ativar usuário'
          }
          description={
            pendingAction.type === 'remove'
              ? `O acesso de ${pendingAction.user.full_name} será excluído definitivamente.`
              : pendingAction.type === 'reset'
                ? `A senha atual de ${pendingAction.user.full_name} deixará de funcionar e uma nova senha provisória será criada.`
                : `${pendingAction.user.full_name} será ${pendingAction.user.status === 'active' ? 'impedido de acessar a plataforma' : 'liberado para acessar os equipamentos permitidos'}.`
          }
          confirmLabel={
            pendingAction.type === 'remove'
              ? 'Excluir usuário'
              : pendingAction.type === 'reset'
                ? 'Gerar senha'
                : pendingAction.user.status === 'active'
                  ? 'Desativar'
                  : 'Ativar'
          }
          danger={
            pendingAction.type === 'remove' ||
            (pendingAction.type === 'toggle' && pendingAction.user.status === 'active')
          }
          onClose={() => setPendingAction(null)}
          onConfirm={() =>
            pendingAction.type === 'remove'
              ? remove(pendingAction.user)
              : pendingAction.type === 'reset'
                ? reset(pendingAction.user)
                : toggle(pendingAction.user)
          }
        />
      )}
    </>
  );
}
