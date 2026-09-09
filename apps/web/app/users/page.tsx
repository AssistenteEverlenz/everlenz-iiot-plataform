'use client';

import { useState } from 'react';
import { mutate, time, usePoll, type Device } from '../../components/data';

interface ManagedUser {
  id: string;
  email: string;
  full_name: string;
  role: 'master' | 'user';
  status: 'active' | 'inactive';
  must_change_password: boolean;
  last_login_at: string | null;
  device_ids: string[];
}

interface UserForm {
  fullName: string;
  email: string;
  status: 'active' | 'inactive';
  deviceIds: string[];
}

const emptyForm: UserForm = { fullName: '', email: '', status: 'active', deviceIds: [] };

export default function UsersPage() {
  const users = usePoll<ManagedUser[]>('/users', 10000);
  const devices = usePoll<Device[]>('/devices?limit=500', 10000);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);

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
    });
    setError('');
    setOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editing) await mutate(`/users/${editing.id}`, 'PATCH', form);
      else {
        const result = await mutate<{ temporaryPassword: string }>('/users', 'POST', form);
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
    if (!window.confirm(`Excluir definitivamente o acesso de ${user.full_name}?`)) return;
    await mutate(`/users/${user.id}`, 'DELETE');
    await users.refresh();
  }

  async function reset(user: ManagedUser) {
    if (!window.confirm(`Gerar uma nova senha provisória para ${user.full_name}?`)) return;
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
        <button className="primary-button" onClick={createUser}>
          ＋ Novo usuário
        </button>
      </div>
      {users.error && <div className="error-banner">{users.error}</div>}
      <section className="user-summary-grid">
        <article className="card">
          <span>USUÁRIOS</span>
          <strong>{users.data?.length ?? '—'}</strong>
          <small>incluindo sua conta master</small>
        </article>
        <article className="card">
          <span>ATIVOS</span>
          <strong>{users.data?.filter((user) => user.status === 'active').length ?? '—'}</strong>
          <small>com acesso liberado</small>
        </article>
        <article className="card">
          <span>AGUARDANDO TROCA</span>
          <strong>{users.data?.filter((user) => user.must_change_password).length ?? '—'}</strong>
          <small>usando senha provisória</small>
        </article>
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
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.full_name}</strong>
                  <small>{user.email}</small>
                </td>
                <td>
                  <span className={`role-badge ${user.role}`}>
                    {user.role === 'master' ? 'MASTER' : 'CLIENTE'}
                  </span>
                </td>
                <td>
                  {user.role === 'master' ? 'Todos' : `${user.device_ids.length} liberado(s)`}
                </td>
                <td>{time(user.last_login_at)}</td>
                <td>
                  <span className={`badge ${user.status === 'active' ? '' : 'offline'}`}>
                    {user.status === 'active' ? 'Ativo' : 'Desativado'}
                  </span>
                  {user.must_change_password && <small>Troca de senha pendente</small>}
                </td>
                <td>
                  <div className="row-actions">
                    {user.role === 'user' && (
                      <>
                        <button onClick={() => editUser(user)}>Editar</button>
                        <button onClick={() => void toggle(user)}>
                          {user.status === 'active' ? 'Desativar' : 'Ativar'}
                        </button>
                        <button onClick={() => void reset(user)}>Nova senha</button>
                        <button className="danger-text" onClick={() => void remove(user)}>
                          Excluir
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
            <div className="device-access-box">
              <div>
                <strong>Equipamentos liberados</strong>
                <small>O usuário verá somente os dados selecionados.</small>
              </div>
              <div className="device-check-grid">
                {devices.data?.map((device) => (
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
                      <small>{device.device_code}</small>
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
    </>
  );
}
