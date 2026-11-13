'use client';

import { useState } from 'react';

/**
 * The setup guide of an HMI (the "i" on a device's sheet): what to type where in the HMI's own
 * software so the device comes online, step by step, with this device's values ready to copy.
 *
 * Delta is written from a real commissioning (DOP-107L1-01, DIAScreen, 2026-11-13) and carries
 * its screenshots and the three certificate files. That firmware only builds its TLS context
 * when a client certificate and key are loaded, even though the broker never asks for them:
 * with those two fields empty it opens the connection and drops it with error 8. The pair served
 * from /hmi/delta is a filler made for that, not a secret: it authenticates nothing.
 *
 * Weintek and Haiwell are written from the field names of their software and have no screenshots
 * yet; the guide says so instead of showing a screen that may not match.
 */

export interface GuideConnection {
  host: string;
  port: number;
  tls: boolean;
  topic: string;
  username: string;
  password?: string;
}

type Field = { label: string; value: string; copy?: boolean };
type Step = {
  title: string;
  where?: string;
  text?: string;
  fields?: Field[];
  files?: boolean;
  warn?: string;
  tip?: string;
  image?: { src: string; caption: string };
};
type Guide = { software: string; verified: boolean; steps: Step[]; errors?: Field[] };

const CA_FILE = 'isrgrootx1.pem';
const FILES = [
  { name: CA_FILE, role: 'CA certificate', hint: 'confere o broker' },
  { name: 'ihm-delta-cliente-cert.pem', role: 'Client credentials', hint: 'só preenche o campo' },
  { name: 'ihm-delta-cliente-chave.pem', role: 'Private Key', hint: 'só preenche o campo' },
];

const passwordField = (c: GuideConnection): Field =>
  c.password
    ? { label: 'Password', value: c.password }
    : { label: 'Password', value: 'a senha da ficha (se perdeu, gere uma nova)', copy: false };

function delta(c: GuideConnection): Guide {
  const steps: Step[] = [
    {
      title: 'Ligue a IHM na rede da fábrica',
      where: 'janela Device Communication › Ethernet1 › Localhost',
      text: 'A IHM precisa sair para a internet. Ligada só no notebook, ponto a ponto, ela não conecta.',
      fields: [
        { label: 'HMI IP Address', value: 'um IP livre na faixa do roteador', copy: false },
        { label: 'Gateway IP', value: 'o IP do roteador', copy: false },
        { label: 'DNS Server', value: '8.8.8.8' },
      ],
      tip: 'Ou marque "Obtain an IP address automatically" e deixe o roteador escolher.',
      image: { src: '/hmi/delta/rede.png', caption: 'Exemplo: troque pelos números da rede do cliente.' },
    },
  ];
  if (c.tls)
    steps.push({
      title: 'Acerte o relógio',
      where: 'janela Configuration › Network Settings',
      text: 'Com TLS, a IHM só tenta conectar depois de sincronizar a hora pela internet.',
      fields: [
        { label: 'Time', value: '(UTC-03:00) Brasília', copy: false },
        { label: 'Server Name', value: '200.160.0.8' },
        { label: 'Calibration when startup', value: 'marcado', copy: false },
        { label: 'Calibration at set intervals', value: 'marcado, 3600 segundos', copy: false },
      ],
      warn: 'Aviso "No server suitable for synchronization found" na tela da IHM = ela está sem internet. Volte ao passo 1.',
      image: { src: '/hmi/delta/relogio.png', caption: 'Servidor de hora do Brasil. O print mostra 60 s do teste: use 3600.' },
    });
  steps.push({
    title: 'Aponte para o broker da Everlenz',
    where: 'janela MQTT Broker Information › aba General',
    fields: [
      { label: 'Server', value: 'General', copy: false },
      { label: 'Communication', value: 'MQTT v3.1.1', copy: false },
      { label: 'IP / URL', value: c.host },
      { label: 'Port', value: String(c.port) },
      { label: 'Client ID', value: c.username },
      { label: 'Account', value: c.username },
      passwordField(c),
      { label: 'QoS', value: '1' },
    ],
    image: { src: '/hmi/delta/broker.png', caption: 'Exemplo de um equipamento já configurado.' },
  });
  steps.push(
    c.tls
      ? {
          title: 'Carregue os três certificados',
          where: 'mesma janela › Cert › botão "…"',
          text: 'Marque Enable, escolha TLS 1.2 e importe um arquivo em cada campo.',
          files: true,
          warn: 'Os três campos precisam ficar como "Imported". Com Client credentials ou Private Key vazios, a IHM dá erro 8 e nunca conecta.',
        }
      : {
          title: 'Deixe o certificado desligado',
          where: 'mesma janela › Cert',
          text: 'Este equipamento está como IHM legada: conecta sem TLS, só pelos IPs liberados na ficha.',
          warn: 'Se a IHM não conectar, abra a ficha do equipamento e libere o IP que aparecer em "tentativas recusadas".',
        },
  );
  steps.push({
    title: 'Ligue o status e deixe o controle vazio',
    where: 'mesma janela › aba Address',
    fields: [
      { label: 'Status Address', value: '$100' },
      { label: 'Control Address', value: 'None (vazio)', copy: false },
    ],
    warn: 'Control Address preenchido zera o IP do broker e desliga o TLS. Deixe em None.',
    tip: 'Ponha dois displays numéricos numa tela da IHM, em $100 e $101: eles dizem se conectou e qual foi o erro.',
    image: { src: '/hmi/delta/status.png', caption: 'Status em $100, controle em None.' },
  });
  steps.push({
    title: 'Crie a publicação e as variáveis',
    where: 'janela MQTT Publisher Property › as duas abas',
    fields: [
      { label: 'Topic', value: c.topic },
      { label: 'Sampling method', value: 'Value change + Timed execution, 10 s', copy: false },
      { label: 'Retain Message', value: 'desmarcado', copy: false },
      { label: 'Content format', value: 'JSON (General)', copy: false },
      { label: 'Timestamp', value: 'marcado', copy: false },
      { label: 'Use "d" for the top level', value: 'marcado', copy: false },
    ],
    tip: 'Em Content Settings, o nome de cada variável é o que aparece na plataforma: sem espaço e sem acento (ex.: QuantidadePaletes).',
    image: { src: '/hmi/delta/variaveis.png', caption: 'Uma linha por variável enviada.' },
  });
  steps.push({
    title: 'Baixe o projeto e confira',
    text: 'Faça o download na IHM e espere ela reiniciar. Em até um minuto o equipamento aparece online na plataforma.',
    fields: [
      { label: '$100 = 2', value: 'conectado', copy: false },
      { label: '$100 = 1', value: 'tentando: veja o erro em $101', copy: false },
      { label: '$100 = 0', value: 'MQTT parado: confira o Enable do broker', copy: false },
    ],
  });
  return {
    software: 'DIAScreen',
    verified: true,
    steps,
    errors: [
      { label: '8', value: 'Certificados: campo vazio, arquivo trocado ou relógio errado' },
      { label: '4', value: 'Achou um servidor que não é o broker: confira IP / URL e Port' },
      { label: '14', value: 'Sem rede até o broker: cabo, gateway ou firewall' },
      { label: '15', value: 'Não resolveu o nome do broker: confira o DNS' },
    ],
  };
}

function weintek(c: GuideConnection): Guide {
  return {
    software: 'EasyBuilder Pro',
    verified: false,
    steps: [
      {
        title: 'Ligue a IHM na rede da fábrica',
        where: 'na IHM: System Settings › Network',
        text: 'A IHM precisa sair para a internet: IP na faixa do roteador, gateway e DNS preenchidos.',
        fields: [{ label: 'DNS', value: '8.8.8.8' }],
      },
      {
        title: 'Crie o servidor MQTT',
        where: 'IIoT/Energy › MQTT › General',
        fields: [
          { label: 'Cloud service', value: 'Normal', copy: false },
          { label: 'Protocol', value: 'MQTT v3.1.1', copy: false },
          { label: 'Domain name', value: c.host },
          { label: 'Port', value: String(c.port) },
          { label: 'Client ID', value: c.username },
          { label: 'Username', value: c.username },
          passwordField(c),
        ],
        tip: 'Marque "Use domain name" para poder digitar o endereço em vez de um IP.',
      },
      c.tls
        ? {
            title: 'Ligue o TLS com o certificado do servidor',
            where: 'mesma janela › TLS/SSL',
            text: 'Marque Enable, escolha TLS 1.2 e importe o arquivo em Server verification.',
            fields: [{ label: 'Server verification', value: CA_FILE, copy: false }],
            files: true,
            warn: 'Use só "Server verification". "Client verification" fica desmarcado.',
          }
        : {
            title: 'Deixe o TLS desligado',
            where: 'mesma janela › TLS/SSL',
            text: 'Este equipamento está como IHM legada: conecta sem TLS, só pelos IPs liberados na ficha.',
          },
      {
        title: 'Crie a publicação e as variáveis',
        where: 'mesma janela › Topic Publisher › New',
        fields: [
          { label: 'Topic', value: c.topic },
          { label: 'Sending mode', value: 'Time-based, 10 s', copy: false },
          { label: 'Content format', value: 'JSON (Simple)', copy: false },
          { label: 'Include timestamp', value: 'marcado, UTC Time', copy: false },
          { label: 'Use top-level key "d"', value: 'marcado', copy: false },
          { label: 'QoS', value: '1' },
        ],
        tip: 'O nome de cada endereço é o que aparece na plataforma: sem espaço e sem acento (ex.: QuantidadePaletes).',
      },
      {
        title: 'Baixe o projeto e confira',
        text: 'Faça o download na IHM. Em até um minuto o equipamento aparece online na plataforma.',
        tip: 'Em General, o "Status address" mostra numa tela da IHM se o MQTT conectou.',
      },
    ],
  };
}

function haiwell(c: GuideConnection): Guide {
  return {
    software: 'Haiwell Cloud SCADA',
    verified: false,
    steps: [
      {
        title: 'Ligue a IHM na rede da fábrica',
        text: 'A IHM precisa sair para a internet: cabo ou Wi-Fi, com gateway e DNS preenchidos.',
        fields: [{ label: 'DNS', value: '8.8.8.8' }],
      },
      {
        title: 'Preencha o servidor MQTT',
        where: 'no projeto: Data Center › MQTT Server (User info)',
        fields: [
          { label: 'Server Host', value: c.host },
          { label: 'Port', value: String(c.port) },
          { label: 'Username', value: c.username },
          passwordField(c),
          { label: 'TLS', value: c.tls ? 'ligado' : 'desligado (IHM legada)', copy: false },
        ],
      },
      {
        title: 'Informe o tópico e as variáveis',
        text: 'As variáveis saem por um grupo de histórico com armazenamento remoto (History Record Group › Remote Storage).',
        fields: [
          { label: 'Tópico', value: c.topic },
          { label: 'QoS', value: '1' },
        ],
        tip: 'O nome de cada variável é o que aparece na plataforma: sem espaço e sem acento (ex.: QuantidadePaletes).',
      },
      {
        title: 'Baixe o projeto e confira',
        text: 'Faça o download na IHM. Em até um minuto o equipamento aparece online na plataforma.',
      },
    ],
  };
}

const GUIDES: Record<string, (c: GuideConnection) => Guide> = {
  Delta: delta,
  Weintek: weintek,
  Haiwell: haiwell,
};

/** True when the brand has a setup guide: the sheet only shows the "i" then. */
export const hasHmiGuide = (manufacturer: string) => manufacturer in GUIDES;

function Value({ field }: { field: Field }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(field.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  const copyable = field.copy !== false;
  return (
    <div className="hmi-field">
      <span>{field.label}</span>
      {copyable ? <code>{field.value}</code> : <em>{field.value}</em>}
      {copyable && (
        <button
          type="button"
          className={`hmi-copy${copied ? ' copied' : ''}`}
          onClick={() => void copy()}
          aria-label={`Copiar ${field.label}`}
        >
          {copied ? '✓ Copiado' : '⧉ Copiar'}
        </button>
      )}
    </div>
  );
}

export function HmiGuide({
  manufacturer,
  model,
  connection,
  onClose,
}: {
  manufacturer: string;
  model: string;
  connection: GuideConnection;
  onClose: () => void;
}) {
  const build = GUIDES[manufacturer];
  if (!build) return null;
  const guide = build(connection);
  const files = manufacturer === 'Delta' ? FILES : FILES.slice(0, 1);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card hmi-guide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <div className="eyebrow">PASSO A PASSO · {guide.software.toUpperCase()}</div>
            <h2>
              Configurar a IHM {manufacturer} <small>{model}</small>
            </h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="hmi-lead">
          <b>{guide.steps.length} passos.</b> No fim, o equipamento aparece online na plataforma. Os
          valores abaixo já são os deste equipamento: é só copiar.
        </p>
        {!guide.verified && (
          <div className="hmi-unverified">
            <b>Roteiro ainda sem prints.</b> Os nomes dos campos podem mudar um pouco conforme a
            versão do {guide.software}.
          </div>
        )}
        <ol className="hmi-steps">
          {guide.steps.map((step, index) => (
            <li key={step.title} className="hmi-step">
              <span className="hmi-number" aria-hidden="true">
                {index + 1}
              </span>
              <div className="hmi-body">
                <h3>{step.title}</h3>
                {step.where && <div className="hmi-where">{step.where}</div>}
                {step.text && <p>{step.text}</p>}
                {step.fields && (
                  <div className="hmi-fields">
                    {step.fields.map((field) => (
                      <Value key={field.label} field={field} />
                    ))}
                  </div>
                )}
                {step.files && (
                  <div className="hmi-files">
                    {files.map((file) => (
                      <a key={file.name} href={`/hmi/delta/${file.name}`} download={file.name}>
                        <span aria-hidden="true">↓</span>
                        <b>{file.role}</b>
                        <small>
                          {file.name} · {file.hint}
                        </small>
                      </a>
                    ))}
                  </div>
                )}
                {step.warn && (
                  <div className="hmi-warn">
                    <span aria-hidden="true">!</span>
                    {step.warn}
                  </div>
                )}
                {step.tip && (
                  <div className="hmi-tip">
                    <span aria-hidden="true">→</span>
                    {step.tip}
                  </div>
                )}
              </div>
              {step.image && (
                <a
                  className="hmi-print"
                  href={step.image.src}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir o print em tamanho real"
                >
                  <img src={step.image.src} alt={`Tela do ${guide.software}: ${step.title}`} loading="lazy" />
                  <small>{step.image.caption}</small>
                </a>
              )}
            </li>
          ))}
        </ol>
        {guide.errors && (
          <section className="hmi-errors">
            <h3>Se não conectar: o número em $101</h3>
            <div className="hmi-fields">
              {guide.errors.map((error) => (
                <div key={error.label} className="hmi-field">
                  <span>erro {error.label}</span>
                  <em>{error.value}</em>
                </div>
              ))}
            </div>
          </section>
        )}
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Fechar o passo a passo
          </button>
        </div>
      </div>
    </div>
  );
}
