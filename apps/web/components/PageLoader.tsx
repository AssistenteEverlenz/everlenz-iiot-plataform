'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { firstLoadsPending, subscribeFirstLoads } from './data';
import { BrandSpinner, type Branding } from './PlatformShell';

// While a page is still waiting for its first answers, its fields are drawn but its numbers
// read zero or a dash: on a slow network that looked like a plant that produced nothing. The
// page is covered instead, with the white label's spinner and a line about what is being read,
// drawn at random from what this page actually does. Once the page has loaded, later refreshes
// and modals never bring the cover back.

const SHOW_AFTER_MS = 300;
const ROTATE_MS = 2200;
// A request that never answers must not hold the page hostage.
const GIVE_UP_MS = 60_000;

const MESSAGES: Array<[RegExp, string[]]> = [
  [
    /^\/dashboards\/[^/]+/,
    [
      'Lendo as variáveis da IHM…',
      'Calculando as fórmulas do painel…',
      'Montando a curva de produção…',
      'Somando as paradas do turno…',
      'Calculando o aproveitamento da máquina…',
      'Desenhando os gráficos dos cards…',
      'Conferindo a meta do turno…',
    ],
  ],
  [/^\/dashboards$/, ['Buscando os painéis…', 'Contando os cards de cada painel…', 'Organizando os painéis por equipamento…']],
  [
    /^\/operations/,
    [
      'Localizando as plantas no mapa…',
      'Lendo o estado de cada máquina…',
      'Calculando a produção do dia…',
      'Medindo o ritmo de cada linha…',
      'Conferindo quem está sem comunicação…',
    ],
  ],
  [
    /^\/production/,
    [
      'Buscando o histórico de produção…',
      'Somando os turnos e os dias…',
      'Calculando o aproveitamento da máquina…',
      'Comparando com a meta…',
      'Separando a produção por produto…',
    ],
  ],
  [
    /^\/devices/,
    ['Buscando os equipamentos…', 'Verificando a comunicação MQTT…', 'Lendo as variáveis publicadas…', 'Conferindo os últimos sinais…'],
  ],
  [/^\/users\/usage/, ['Contando os acessos…', 'Calculando o tempo de uso…', 'Montando o ranking de uso…', 'Separando o tempo em modo TV…']],
  [/^\/users/, ['Buscando os usuários…', 'Conferindo os equipamentos liberados…', 'Lendo os últimos acessos…']],
  [/^\/settings/, ['Carregando a identidade visual…', 'Aplicando as cores da marca…']],
  [/^\/mqtt-inspector/, ['Escutando o broker MQTT…', 'Lendo as mensagens recebidas…', 'Identificando os tópicos…']],
  [
    /^\/$/,
    [
      'Reunindo os indicadores das plantas…',
      'Calculando a produção de hoje…',
      'Lendo o estado das máquinas…',
      'Somando as paradas do dia…',
    ],
  ],
];
const FALLBACK = ['Carregando os dados…', 'Sincronizando com as máquinas…', 'Calculando as variáveis…'];

function messagesFor(pathname: string) {
  return MESSAGES.find(([pattern]) => pattern.test(pathname))?.[1] ?? FALLBACK;
}
function pick(list: string[], not?: string) {
  const options = list.length > 1 ? list.filter((item) => item !== not) : list;
  return options[Math.floor(Math.random() * options.length)];
}

export function PageLoader({ pathname, branding }: { pathname: string; branding: Branding }) {
  const pending = useSyncExternalStore(subscribeFirstLoads, firstLoadsPending, () => 0);
  const [settled, setSettled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState(() => pick(messagesFor(pathname)));

  // A new page starts unsettled, and gives up waiting after a while whatever happens.
  useEffect(() => {
    setSettled(false);
    setVisible(false);
    setMessage(pick(messagesFor(pathname)));
    const show = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    const cap = window.setTimeout(() => setSettled(true), GIVE_UP_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(cap);
    };
  }, [pathname]);

  // Settled once nothing is pending for a moment: a page often asks for more after its first
  // answer (a board, then its shift), so a short grace avoids a cover that blinks off and on.
  useEffect(() => {
    if (settled || pending > 0) return undefined;
    const done = window.setTimeout(() => setSettled(true), 250);
    return () => window.clearTimeout(done);
  }, [pending, settled]);

  useEffect(() => {
    if (settled) return undefined;
    const timer = window.setInterval(
      () => setMessage((current) => pick(messagesFor(pathname), current)),
      ROTATE_MS,
    );
    return () => window.clearInterval(timer);
  }, [settled, pathname]);

  if (settled || !visible || pending === 0) return null;
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <BrandSpinner branding={branding} />
      <strong key={message}>{message}</strong>
    </div>
  );
}
