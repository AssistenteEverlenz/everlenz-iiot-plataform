'use client';
import Link from 'next/link';
import { usePoll, time, type Device, type Topic } from '../components/data';
import { DevicesTable } from '../components/DevicesTable';
export default function Home() {
  const overview = usePoll<{
    devices: number;
    messagesPerMinute: number;
    lastMessageAt: string | null;
  }>('/overview');
  const health = usePoll<{ broker: boolean; api: boolean }>('/health');
  const devices = usePoll<Device[]>('/devices');
  const topics = usePoll<Topic[]>('/mqtt/topics?limit=5');
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">OPERAÇÃO EM TEMPO REAL</div>
          <h1>Centro de comando</h1>
          <p>Da máquina à decisão. Acompanhe a operação industrial em um só lugar.</p>
        </div>
        <Link className="primary-button" href="/dashboards">
          Abrir painéis →
        </Link>
      </div>
      {(overview.error || health.error) && (
        <div className="error-banner">
          {overview.error || health.error} · Verifique API, ingestor e broker.
        </div>
      )}
      <div className="stats">
        <div className="card">
          <div className="stat-label">Broker MQTT / API</div>
          <div className="stat-value">
            {health.error ? 'Indisponível' : health.data?.broker ? 'Conectado' : '—'}
          </div>
          <div className="stat-note">Eclipse Mosquitto · self-hosted</div>
        </div>
        <div className="card">
          <div className="stat-label">Dispositivos</div>
          <div className="stat-value">{overview.data?.devices ?? '—'}</div>
          <div className="stat-note">Cadastrados neste tenant</div>
        </div>
        <div className="card">
          <div className="stat-label">Mensagens por minuto</div>
          <div className="stat-value">
            {overview.data?.messagesPerMinute.toLocaleString('pt-BR') ?? '—'}
          </div>
          <div className="stat-note">Ritmo recebido nos últimos 60 segundos</div>
        </div>
        <div className="card">
          <div className="stat-label">Última mensagem</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {time(overview.data?.lastMessageAt)}
          </div>
          <div className="stat-note">Horário local do navegador</div>
        </div>
      </div>
      <section className="card">
        <h2>Dispositivos monitorados</h2>
        <DevicesTable devices={devices.data} />
      </section>
      <div className="grid section-space">
        <section className="card">
          <h2>Pipeline de telemetria</h2>
          <p>Captura original preservada antes da interpretação.</p>
          <div className="flow">
            <b>Equipamento</b>→<b>Mosquitto</b>→<b>RAW</b>→<b>Adapter</b>→<b>PostgreSQL</b>
          </div>
          <span className="badge">Somente monitoramento e leitura</span>
        </section>
        <section className="card">
          <h2>
            Atividade MQTT{' '}
            <Link className="device-link" href="/mqtt-inspector">
              ↗
            </Link>
          </h2>
          {topics.data?.map((t) => (
            <div key={t.topic} style={{ marginBottom: 14 }}>
              <div className="mono">{t.topic}</div>
              <div className="subline">
                {t.message_count} mensagens · {time(t.last_seen)}
              </div>
            </div>
          ))}
          {!topics.data?.length && <p>Aguardando publicações do simulador ou equipamento.</p>}
        </section>
      </div>
      <footer>POC Industrial / Laboratório · HaiwellAdapter experimental</footer>
    </>
  );
}
