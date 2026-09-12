'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function LoginForm() {
  const search = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // "Manter conectado": 30 days renewed while in use instead of the 4 h idle / 12 h limits.
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, remember }),
    });
    setLoading(false);
    if (!response.ok) {
      setError(
        response.status === 403
          ? 'Este acesso está desativado. Fale com o administrador.'
          : response.status === 429
            ? 'Muitas tentativas. Aguarde alguns minutos.'
            : 'E-mail ou senha inválidos.',
      );
      return;
    }
    const next = search.get('next');
    window.location.replace(next?.startsWith('/') ? next : '/');
  }
  return (
    <main className="login-page">
      <section className="login-visual">
        <div className="login-grid" />
        <div className="login-brand">
          <span>e</span>
          <div>
            <strong>everlenz</strong>
            <small>INDUSTRIAL INTELLIGENCE</small>
          </div>
        </div>
        <div className="login-message">
          <div className="eyebrow">GESTÃO INDUSTRIAL EM TEMPO REAL</div>
          <h1>Decisões melhores começam no chão de fábrica.</h1>
          <p>Produção, disponibilidade e desempenho reunidos em uma visão clara da operação.</p>
        </div>
        <div className="login-signal">
          <span className="live-dot" /> Broker MQTT conectado
        </div>
      </section>
      <section className="login-access">
        <form className="login-card" onSubmit={submit}>
          <div className="eyebrow">ACESSO À PLATAFORMA</div>
          <h2>Bem-vindo</h2>
          <p>Entre com as credenciais fornecidas pelo administrador.</p>
          <label className="field">
            E-mail
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="voce@empresa.com.br"
            />
          </label>
          <label className="field">
            Senha
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="login-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>
              Manter conectado
              <small>Use em computadores e TVs da empresa. Continua logado até você sair.</small>
            </span>
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button login-button" disabled={loading}>
            {loading && <span className="button-spinner" />}
            {loading ? 'Validando acesso...' : 'Entrar'}
          </button>
          <small className="login-support">Acesso protegido e individual por equipamento.</small>
        </form>
      </section>
    </main>
  );
}

export default function Login() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
