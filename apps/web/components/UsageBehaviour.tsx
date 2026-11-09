'use client';

import type React from 'react';
import { useState } from 'react';

// How the platform is used, from the behaviour events (migration 056), for the master alone:
// where people got stuck, how long a visit to each page lasts, and what they click. The same
// section on the usage page (everyone but the master accounts) and in one person's window.
// The question it answers: what should change in the platform next?

export interface Behaviour {
  since: string | null;
  kinds: Record<string, { count: number; people: number }>;
  signals: Array<{
    kind: string;
    page: string;
    target: string | null;
    count: number;
    people: number;
    lastAt: string;
  }>;
  screens: Array<{
    page: string;
    visits: number;
    averageMs: number;
    totalMs: number;
    people: number;
  }>;
  clicks: Array<{ page: string; target: string | null; count: number; people: number }>;
}

type Signal = 'repeat' | 'dead' | 'modal' | 'form_abandoned' | 'empty_search' | 'error';

/** Each signal in plain words: what happened, and what it usually means for the screen. */
const SIGNALS: Record<
  Signal,
  { title: string; did: string; means: string; tone: 'warn' | 'bad'; icon: React.ReactNode }
> = {
  repeat: {
    title: 'Clique repetido',
    did: 'Clicou 3 vezes seguidas em',
    means: 'Parece clicável e não é, ou demorou a responder: dar retorno ou tornar clicável.',
    tone: 'warn',
    icon: <path d="M9 9l5 12 1.8-5.2L21 14 9 9zM4 4l2 2M9 2v3M2 9h3M14 4l-2 2" />,
  },
  dead: {
    title: 'Clique sem ação',
    did: 'Clicou onde nada acontece:',
    means: 'A pessoa esperava abrir algo ali: criar a ação esperada (abrir o detalhe).',
    tone: 'warn',
    icon: (
      <>
        <path d="M9 9l5 12 1.8-5.2L21 14 9 9z" />
        <path d="M3 3l18 18" />
      </>
    ),
  },
  modal: {
    title: 'Fechou na hora',
    did: 'Abriu e fechou em menos de 2 s:',
    means: 'Caminho errado: o nome do botão promete outra coisa. Mudar rótulo ou posição.',
    tone: 'warn',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 10l6 6M15 10l-6 6" />
      </>
    ),
  },
  form_abandoned: {
    title: 'Desistiu do formulário',
    did: 'Começou a preencher e fechou sem salvar:',
    means: 'Atrito no lançamento: campos demais ou padrão errado. Simplificar.',
    tone: 'warn',
    icon: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6M9 14h6" />
      </>
    ),
  },
  empty_search: {
    title: 'Busca sem resultado',
    did: 'Buscou e não achou:',
    means: 'A pessoa chama a coisa por outro nome: aceitar o nome dela na busca.',
    tone: 'warn',
    icon: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3M8.5 11h5" />
      </>
    ),
  },
  error: {
    title: 'Erro na tela',
    did: 'Encontrou um erro:',
    means: 'Defeito da plataforma: corrigir.',
    tone: 'bad',
    icon: (
      <>
        <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
  },
};
const ORDER: Signal[] = ['repeat', 'dead', 'modal', 'form_abandoned', 'empty_search', 'error'];

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** "45 s", "3 min 20 s", "1h 05min". */
function seconds(ms: number) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min${total % 60 ? ` ${total % 60} s` : ''}`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`;
}
const dayMonth = (value: string) =>
  new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit' });
const dateTime = (value: string) =>
  new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
/** Digits were masked when recorded ("Lote ####"): show the mask as a single mark. */
const control = (target: string | null) => (target ? target.replace(/#+/g, '#') : 'sem nome');

export function UsageBehaviour({
  data,
  everyone,
}: {
  data: Behaviour | null | undefined;
  /** The whole plant (people count shown) or one person. */
  everyone: boolean;
}) {
  const [only, setOnly] = useState<Signal | null>(null);
  if (data === undefined) return null;

  const heading = everyone ? 'Como as pessoas usam a plataforma' : 'Como usa a plataforma';
  if (data === null || !data.since)
    return (
      <section className="card usage-behaviour">
        <div className="ub-head">
          <strong>{heading}</strong>
        </div>
        <p className="shifts-help">
          Nenhum clique registrado ainda. O registro começa quando as pessoas abrem a plataforma
          depois desta versão.
        </p>
      </section>
    );

  const stuck = ORDER.reduce((sum, kind) => sum + (data.kinds[kind]?.count ?? 0), 0);
  const list = data.signals.filter((signal) => !only || signal.kind === only);
  const longest = Math.max(1, ...data.screens.map((screen) => screen.totalMs));
  const mostClicked = Math.max(1, ...data.clicks.map((item) => item.count));

  return (
    <section className={everyone ? 'card usage-behaviour' : 'usage-behaviour'}>
      <div className="ub-head">
        <strong>{heading}</strong>
        <small>
          Registrado desde {dayMonth(data.since)} · nunca o que é digitado
          {everyone ? ' · contas master não entram' : ''}
        </small>
      </div>

      <div className="ub-lead">
        <b>{stuck}</b>
        <span>
          {stuck === 1 ? 'momento' : 'momentos'} em que a tela confundiu
          {data.screens.length
            ? ` · ${data.screens.reduce((sum, screen) => sum + screen.visits, 0)} telas abertas`
            : ''}
        </span>
      </div>

      <div className="ub-kinds" role="group" aria-label="Filtrar por tipo">
        {ORDER.map((kind) => {
          const figure = data.kinds[kind];
          const meta = SIGNALS[kind];
          return (
            <button
              key={kind}
              type="button"
              className={`ub-kind ${meta.tone}${only === kind ? ' active' : ''}${figure ? '' : ' zero'}`}
              aria-pressed={only === kind}
              onClick={() => setOnly(only === kind ? null : kind)}
              title={meta.means}
            >
              <span className="ub-ico">
                <Icon>{meta.icon}</Icon>
              </span>
              <b>{figure?.count ?? 0}</b>
              <span>{meta.title}</span>
              {everyone && figure && (
                <small>
                  {figure.people} {figure.people === 1 ? 'pessoa' : 'pessoas'}
                </small>
              )}
            </button>
          );
        })}
      </div>

      <div className="detail-section">
        <strong>Onde travou{only ? ` · ${SIGNALS[only].title.toLowerCase()}` : ''}</strong>
        {everyone && (
          <small className="ub-note">O que aconteceu com mais pessoas vem primeiro.</small>
        )}
        {list.length ? (
          <ul className="ub-list">
            {list.map((signal) => {
              const meta = SIGNALS[signal.kind as Signal];
              if (!meta) return null;
              return (
                <li key={`${signal.kind}|${signal.page}|${signal.target}`} className={meta.tone}>
                  <span className="ub-ico">
                    <Icon>{meta.icon}</Icon>
                  </span>
                  <div>
                    <p>
                      {meta.did} <b>{control(signal.target)}</b>
                    </p>
                    <small>
                      {signal.page} · {meta.means}
                    </small>
                  </div>
                  <div className="ub-count">
                    <b>
                      {signal.count} {signal.count === 1 ? 'vez' : 'vezes'}
                    </b>
                    <small>
                      {everyone
                        ? `${signal.people} ${signal.people === 1 ? 'pessoa' : 'pessoas'} · `
                        : ''}
                      {dateTime(signal.lastAt)}
                    </small>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="shifts-help">
            {only
              ? 'Nada deste tipo no período.'
              : 'Ninguém travou em nada neste período: nenhum clique repetido, janela fechada na hora ou busca sem resultado.'}
          </p>
        )}
      </div>

      <div className="usage-two">
        <div className="detail-section">
          <strong>Tempo por tela</strong>
          {data.screens.length ? (
            <div className="ub-scroll">
              <table className="detail-table ub-table">
                <thead>
                  <tr>
                    <th>Tela</th>
                    <th className="n">Visitas</th>
                    <th className="n">Média por visita</th>
                    {everyone && <th className="n">Pessoas</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.screens.map((screen) => (
                    <tr key={screen.page}>
                      <td>
                        {screen.page}
                        <span
                          className="ub-bar"
                          style={{ width: `${(screen.totalMs / longest) * 100}%` }}
                        />
                      </td>
                      <td className="n">{screen.visits}</td>
                      <td className="n">{seconds(screen.averageMs)}</td>
                      {everyone && <td className="n">{screen.people}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="shifts-help">Sem telas registradas no período.</p>
          )}
        </div>
        <div className="detail-section">
          <strong>O que mais clicam</strong>
          {data.clicks.length ? (
            <div className="ub-scroll">
              <table className="detail-table ub-table">
                <thead>
                  <tr>
                    <th>Botão</th>
                    <th className="n">Vezes</th>
                    {everyone && <th className="n">Pessoas</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.clicks.map((item) => (
                    <tr key={`${item.page}|${item.target}`}>
                      <td>
                        {control(item.target)}
                        <small>{item.page}</small>
                        <span
                          className="ub-bar"
                          style={{ width: `${(item.count / mostClicked) * 100}%` }}
                        />
                      </td>
                      <td className="n">{item.count}</td>
                      {everyone && <td className="n">{item.people}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="shifts-help">Sem cliques registrados no período.</p>
          )}
        </div>
      </div>
    </section>
  );
}
