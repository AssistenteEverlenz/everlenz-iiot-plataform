'use client';
import { useEffect, useState } from 'react';

export function AdminAccess({ onReady }: { onReady?: () => void }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void fetch('/api/admin/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((result: { authenticated: boolean }) => setAuthenticated(result.authenticated));
  }, []);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const response = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      setError('Senha inválida.');
      return;
    }
    setAuthenticated(true);
    setOpen(false);
    setPassword('');
    onReady?.();
  }
  if (authenticated)
    return (
      <span className="admin-state">
        <span className="live-dot" /> Modo de edição
      </span>
    );
  return (
    <>
      <button className="secondary-button" onClick={() => setOpen(true)}>
        Entrar para editar
      </button>
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <form
            className="modal-card compact-modal"
            onSubmit={login}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="eyebrow">ACESSO PROTEGIDO</div>
            <h2>Modo administrador</h2>
            <p>Use a senha administrativa da plataforma para cadastrar ativos e alterar painéis.</p>
            <label className="field">
              Senha
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
                Cancelar
              </button>
              <button className="primary-button" type="submit">
                Entrar
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
