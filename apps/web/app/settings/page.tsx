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
      setMessage('Identidade atualizada em toda a plataforma.');
      await branding.refresh();
      await platform.refreshBranding();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }
  async function selectLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setMessage('Use uma imagem PNG, JPG ou WebP.');
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage('A imagem deve ter no máximo 5 MB.');
      event.target.value = '';
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const maximum = 384;
      const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const logoUrl = canvas.toDataURL('image/webp', 0.9);
      if (logoUrl.length > 850_000) throw new Error('Imagem ainda muito grande após otimização.');
      setForm((current) => ({ ...current, logoUrl }));
      setMessage('Logotipo otimizado e pronto para salvar.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível processar a imagem.');
      event.target.value = '';
    }
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
            <small>PNG, JPG ou WebP com até 5 MB. O arquivo será otimizado automaticamente.</small>
          </label>
          {form.logoUrl && (
            <div className="logo-upload-preview">
              <img src={form.logoUrl} alt="Prévia do logotipo" />
              <button type="button" onClick={() => setForm({ ...form, logoUrl: '' })}>
                Remover
              </button>
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
