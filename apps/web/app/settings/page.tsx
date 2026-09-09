'use client';

import { useEffect, useState } from 'react';
import { mutate, usePoll } from '../../components/data';
import { usePlatform, type Branding } from '../../components/PlatformShell';

export default function SettingsPage() {
  const branding = usePoll<Branding>('/branding', 60000);
  const platform = usePlatform();
  const [form, setForm] = useState({
    productName: '',
    subtitle: '',
    logoUrl: '',
    primaryColor: '#0b2028',
    accentColor: '#12b8a6',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (branding.data)
      setForm({
        productName: branding.data.product_name,
        subtitle: branding.data.subtitle,
        logoUrl: branding.data.logo_url ?? '',
        primaryColor: branding.data.primary_color,
        accentColor: branding.data.accent_color,
      });
  }, [branding.data]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await mutate('/branding', 'PATCH', form);
      setMessage('Identidade atualizada. Recarregue a página para aplicar em todo o menu.');
      await branding.refresh();
      await platform.refreshSession();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  function selectLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setMessage('Use uma imagem PNG, JPG ou WebP.');
      event.target.value = '';
      return;
    }
    if (file.size > 600 * 1024) {
      setMessage('A imagem deve ter no máximo 600 KB.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((current) => ({ ...current, logoUrl: String(reader.result ?? '') }));
      setMessage('');
    };
    reader.readAsDataURL(file);
  }
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">IDENTIDADE DA PLATAFORMA</div>
          <h1>White label</h1>
          <p>Personalize a marca exibida no menu e nas telas de acesso.</p>
        </div>
      </div>
      <div className="settings-layout">
        <form className="card brand-form" onSubmit={save}>
          <label className="field">
            Nome do produto
            <input
              required
              value={form.productName}
              onChange={(event) => setForm({ ...form, productName: event.target.value })}
            />
          </label>
          <label className="field">
            Assinatura
            <input
              required
              value={form.subtitle}
              onChange={(event) => setForm({ ...form, subtitle: event.target.value })}
            />
          </label>
          <label className="field">
            Arquivo do logotipo
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectLogo} />
            <small>PNG, JPG ou WebP com até 600 KB. A imagem também será usada no carregamento.</small>
          </label>
          {form.logoUrl && (
            <div className="logo-upload-preview">
              <img src={form.logoUrl} alt="Prévia do logotipo" />
              <button type="button" onClick={() => setForm({ ...form, logoUrl: '' })}>Remover</button>
            </div>
          )}
          <div className="color-fields">
            <label className="field">
              Cor principal
              <input
                type="color"
                value={form.primaryColor}
                onChange={(event) => setForm({ ...form, primaryColor: event.target.value })}
              />
            </label>
            <label className="field">
              Cor de destaque
              <input
                type="color"
                value={form.accentColor}
                onChange={(event) => setForm({ ...form, accentColor: event.target.value })}
              />
            </label>
          </div>
          {message && <div className="form-message">{message}</div>}
          <button className="primary-button" disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar identidade'}
          </button>
        </form>
        <section
          className="brand-preview"
          style={{ background: `linear-gradient(145deg,${form.primaryColor},#173f48)` }}
        >
          <span style={{ background: form.accentColor }}>
            {form.logoUrl ? <img src={form.logoUrl} alt="" /> : 'e'}
          </span>
          <div>
            <strong>{form.productName || 'Nome da plataforma'}</strong>
            <small>{form.subtitle || 'Assinatura da marca'}</small>
          </div>
          <p>Prévia do menu e da tela de acesso.</p>
        </section>
      </div>
    </>
  );
}
