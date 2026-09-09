'use client';
import { useState } from 'react';
import { usePoll, type Raw, type Topic, time } from '../../components/data';
function processingLabel(raw: Raw) {
  if (raw.processing_status === 'pending') return 'Processando agora';
  if (raw.processing_status === 'processed') return 'Processada';
  if (raw.processing_status === 'unrecognized') return 'Não reconhecida';
  return 'Erro';
}
function processingDuration(raw: Raw) {
  if (!raw.processed_at) return null;
  const milliseconds = new Date(raw.processed_at).getTime() - new Date(raw.received_at).getTime();
  return milliseconds < 1000
    ? `${Math.max(0, milliseconds)} ms`
    : `${(milliseconds / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s`;
}
export default function Inspector() {
  const [topic, setTopic] = useState(''),
    [status, setStatus] = useState(''),
    [offset, setOffset] = useState(0),
    [chosen, setChosen] = useState<Raw | null>(null),
    [topicOffset, setTopicOffset] = useState(0);
  const topics = usePoll<Topic[]>(`/mqtt/topics?limit=50&offset=${topicOffset}`, 5000);
  const overview = usePoll<{ operatorRawAccess: boolean }>('/overview', 5000);
  const raw = usePoll<Raw[]>(
    `/mqtt/raw?limit=25&offset=${offset}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}${status ? `&processingStatus=${status}` : ''}`,
    1000,
  );
  const selected = raw.data?.find((r) => r.id === chosen?.id) ?? chosen ?? raw.data?.[0];
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">DIAGNÓSTICO DE CAMPO</div>
          <h1>MQTT Inspector</h1>
          <p>Explore tópicos, payloads originais e resultados dos adapters.</p>
        </div>
        <span className="pill">ATUALIZAÇÃO · 1 S</span>
      </div>
      {overview.data?.operatorRawAccess ? (
        <div className="error-banner">
          Modo operador local: inclui mensagens sem tenant identificado.
        </div>
      ) : (
        <p>
          Escopo do tenant atual. Para descoberta de tópicos desconhecidos, habilite
          OPERATOR_RAW_ACCESS no ambiente local.
        </p>
      )}
      {(raw.error || topics.error) && (
        <div className="error-banner">{raw.error || topics.error}</div>
      )}
      <section className="card">
        <h2>Tópicos descobertos</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>TÓPICO</th>
                <th>MENSAGENS</th>
                <th>PRIMEIRA OCORRÊNCIA</th>
                <th>ÚLTIMA OCORRÊNCIA</th>
              </tr>
            </thead>
            <tbody>
              {topics.data?.map((t) => (
                <tr key={t.topic}>
                  <td>
                    <button
                      className="topic-button mono"
                      onClick={() => {
                        setTopic(t.topic);
                        setOffset(0);
                        setChosen(null);
                      }}
                    >
                      {t.topic}
                    </button>
                  </td>
                  <td>{t.message_count}</td>
                  <td>{time(t.first_seen)}</td>
                  <td>{time(t.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!topics.data?.length && (
          <div className="empty">Nenhum tópico recebido. Execute pnpm simulator:haiwell.</div>
        )}
        <div className="pager">
          <button disabled={!topicOffset} onClick={() => setTopicOffset(topicOffset - 50)}>
            Anterior
          </button>
          <span>Tópicos · página {topicOffset / 50 + 1}</span>
          <button
            disabled={!topics.data || topics.data.length < 50}
            onClick={() => setTopicOffset(topicOffset + 50)}
          >
            Próxima
          </button>
        </div>
      </section>
      <div className="controls">
        <input
          aria-label="Filtrar tópico exato"
          placeholder="Filtrar tópico exato…"
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            setOffset(0);
            setChosen(null);
          }}
        />
        <select
          aria-label="Status do processamento"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
            setChosen(null);
          }}
        >
          <option value="">Todos os status</option>
          {['processed', 'unrecognized', 'error', 'pending'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={() => {
            setTopic('');
            setStatus('');
            setOffset(0);
            setChosen(null);
          }}
        >
          Limpar filtros
        </button>
      </div>
      <div className="inspector">
        <section className="card">
          <h2>Mensagens RAW</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>RECEBIDA / TÓPICO</th>
                  <th>STATUS</th>
                  <th>QoS</th>
                </tr>
              </thead>
              <tbody>
                {raw.data?.map((r) => (
                  <tr key={r.id} className={selected?.id === r.id ? 'selected' : ''}>
                    <td>
                      <button className="topic-button" onClick={() => setChosen(r)}>
                        {time(r.received_at)}
                      </button>
                      <div className="subline mono">{r.topic}</div>
                    </td>
                    <td>
                      <span className={`badge ${r.processing_status}`}>{r.processing_status}</span>
                      <small className="processing-duration">
                        {processingDuration(r) ?? processingLabel(r)}
                      </small>
                    </td>
                    <td>{r.qos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!raw.data?.length && <div className="empty">Nenhuma mensagem para estes filtros.</div>}
          <div className="pager">
            <button
              disabled={!offset}
              onClick={() => {
                setOffset(offset - 25);
                setChosen(null);
              }}
            >
              Anterior
            </button>
            <span>Página {offset / 25 + 1}</span>
            <button
              disabled={!raw.data || raw.data.length < 25}
              onClick={() => {
                setOffset(offset + 25);
                setChosen(null);
              }}
            >
              Próxima
            </button>
          </div>
        </section>
        <section className="card">
          <h2>Payload original</h2>
          {selected ? (
            <>
              <div className="mono">{selected.topic}</div>
              <div className="controls">
                <span className="pill">QoS {selected.qos}</span>
                <span className="pill">RETAIN {String(selected.retain)}</span>
                <span className={`badge ${selected.processing_status}`}>
                  {processingLabel(selected)}
                </span>
              </div>
              <p>
                Parser: {selected.parser_used ?? 'Não identificado'}
                <br />
                Recebida: {time(selected.received_at)} · processamento{' '}
                {processingDuration(selected) ?? 'em andamento'} · RAW #{selected.id}
              </p>
              {selected.processing_error && (
                <div className="error-banner">{selected.processing_error}</div>
              )}
              <pre className="payload">
                {selected.parsed_json !== null
                  ? JSON.stringify(selected.parsed_json, null, 2)
                  : (selected.payload_text ?? `HEX: ${selected.payload_hex}`)}
              </pre>
              <details>
                <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>
                  Bytes originais (hexadecimal)
                </summary>
                <pre className="payload">{selected.payload_hex}</pre>
              </details>
            </>
          ) : (
            <div className="empty">Selecione uma mensagem para inspecionar.</div>
          )}
        </section>
      </div>
    </>
  );
}
