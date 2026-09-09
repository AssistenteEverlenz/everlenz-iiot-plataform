'use client';
import { usePoll, type Device } from '../../components/data';

export default function Integrations() {
  const devices = usePoll<Device[]>('/devices');
  const first = devices.data?.[0];
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">DADOS ABERTOS, ACESSO CONTROLADO</div>
          <h1>Integrações e exportações</h1>
          <p>Entregue dados industriais para análise, auditoria ou outros sistemas.</p>
        </div>
      </div>
      <div className="integration-grid">
        <section className="integration-card">
          <span className="integration-icon">CSV</span>
          <h2>Planilha de telemetria</h2>
          <p>
            Arquivo UTF-8 compatível com Excel, contendo horários, ativo, variável, unidade, valor e
            qualidade.
          </p>
          {first ? (
            <a
              className="primary-button"
              href={`/api/export/telemetry.csv?deviceId=${first.id}&limit=10000`}
            >
              Baixar CSV
            </a>
          ) : (
            <button disabled>Aguardando dispositivo</button>
          )}
        </section>
        <section className="integration-card">
          <span className="integration-icon">PDF</span>
          <h2>Relatório visual</h2>
          <p>
            Abra um painel, escolha o período e use “Exportar PDF” para gerar a visão executiva
            pronta para compartilhar.
          </p>
          <a className="secondary-button" href="/dashboards/55555555-5555-4555-8555-555555555555">
            Abrir painel
          </a>
        </section>
        <section className="integration-card">
          <span className="integration-icon">API</span>
          <h2>API JSON</h2>
          <p>
            Consulta paginada protegida pela sessão do usuário. Tokens de serviço para integrações
            automáticas serão cadastrados nesta área em uma próxima etapa.
          </p>
          <pre className="api-example">
            GET /api/telemetry?deviceId={'{UUID}'}&from={'{ISO-8601}'}
          </pre>
        </section>
      </div>
      <section className="card section-space">
        <div className="eyebrow">CONTRATO DE INTEGRAÇÃO</div>
        <h2>Identidade estável</h2>
        <p>
          Cada equipamento possui um UUID imutável para APIs e um código Everlenz curto para
          pessoas. Trocar o nome da máquina não rompe integrações nem históricos.
        </p>
        <div className="device-code-list">
          {devices.data?.map((device) => (
            <div key={device.id}>
              <span>{device.name}</span>
              <b>{device.device_code}</b>
              <code>{device.id}</code>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
