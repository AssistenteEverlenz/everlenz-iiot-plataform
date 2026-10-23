'use client';

import type { ReactNode } from 'react';
import {
  BagRuler,
  GROUPS,
  Icon,
  KINDS,
  SiloIcon,
  TagIcon,
  recallReconcile,
  type BridgeKind,
  type Group,
} from './MortarBridge';
import { integer, tons } from './mortarShared';

/**
 * The guide of the yield card (the "i" beside its pencil): what each line of the sum means, drawn
 * before it is written. The path of the mass first -- scale, buffer silo, spouts -- since every
 * line is something that happens on it; the three colours; then a card per line, with a small
 * scene of icons and arrows, what it is in one sentence, what to do, and how much of it the
 * period open on the card has. The lines of that period come first; the others stay below,
 * lighter, for when they appear.
 */

const Scale = () => <Icon d="M4 20h16M7 20V10h10v10M12 10V4M8 6h8" />;
const Bag = () => <Icon d="M6 8h12l1.5 12h-15zM9 8a3 3 0 016 0" />;
const Clock = () => <Icon d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2" />;
const Burst = () => <Icon d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2" />;
const Question = () => <Icon d="M9.1 9a3 3 0 015.8 1c0 2-3 2.5-3 4.5M12 18h.01" />;
const Drop = () => <Icon d="M12 3c3 4 6 7.5 6 11a6 6 0 01-12 0c0-3.5 3-7 6-11z" />;
const WifiOff = () => (
  <Icon d="M2 8.5a15 15 0 0120 0M5 12a10 10 0 0114 0M8.5 15.5a5 5 0 017 0M12 19h.01M3 3l18 18" />
);

type Step = { icon: ReactNode; text: string; tone?: 'mix' | 'silo' | 'bag' | 'bad' | 'muted' };
type Joint = '→' | '≠' | '⇄';

const GUIDE: Record<
  BridgeKind,
  { scene: Array<Step | Joint>; what: string; todo: string; ruler?: boolean }
> = {
  carryIn: {
    scene: [
      { icon: <Scale />, text: 'misturado antes', tone: 'mix' },
      '→',
      { icon: <SiloIcon />, text: 'esperou no silo', tone: 'silo' },
      '→',
      { icon: <Bag />, text: 'ensacado no período', tone: 'bag' },
    ],
    what: 'Massa misturada antes do período que só virou saco dentro dele. O silo pulmão guarda massa de um dia para o outro: o que sobra no fim do expediente sai em sacos na manhã seguinte. Por isso o dia ensaca mais do que misturou.',
    todo: 'Nada. É só o tempo do silo: somando os dias, se compensa com o "Ficou no silo" do dia anterior.',
  },
  carryOut: {
    scene: [
      { icon: <Scale />, text: 'misturado no período', tone: 'mix' },
      '→',
      { icon: <SiloIcon />, text: 'ficou no silo', tone: 'silo' },
      '→',
      { icon: <Bag />, text: 'ensacado depois', tone: 'muted' },
    ],
    what: 'Massa misturada no período que só virou saco depois dele: estava no silo quando o período terminou. Por isso o dia ensaca menos do que misturou.',
    todo: 'Nada. Aparece como "Veio do silo" no dia seguinte.',
  },
  silo: {
    scene: [
      { icon: <Scale />, text: 'misturado agora', tone: 'mix' },
      '→',
      { icon: <SiloIcon />, text: 'ainda no silo', tone: 'silo' },
      '→',
      { icon: <Bag />, text: 'saindo em sacos', tone: 'muted' },
    ],
    what: 'A produção em andamento: parte da última mistura ainda está no silo, esperando a vez de sair em sacos.',
    todo: 'Nada. Some sozinho conforme a ensacadeira trabalha.',
  },
  offline: {
    scene: [
      { icon: <WifiOff />, text: 'IHM sem sinal', tone: 'bad' },
      '→',
      { icon: <Clock />, text: 'guardou os dados', tone: 'muted' },
      '→',
      { icon: <Burst />, text: 'mandou tudo junto', tone: 'bad' },
    ],
    what: 'A IHM perdeu a comunicação, guardou o que aconteceu e mandou tudo de uma vez quando voltou, com o horário do envio. Bateladas e sacos daquele trecho ficaram com a hora errada, então não dá para casar um com o outro.',
    todo: 'Verifique a internet da IHM. Se acontece muito, configure o envio offline para manter o horário original.',
  },
  unassigned: {
    scene: [
      { icon: <TagIcon />, text: 'bico: Reboco', tone: 'bag' },
      '≠',
      { icon: <Scale />, text: 'misturador: AC2', tone: 'mix' },
      '→',
      { icon: <Bag />, text: 'saco sem mistura', tone: 'bad' },
    ],
    what: 'Saíram sacos com o nome de um produto que o misturador não estava fazendo. Quase sempre o bico ficou com a receita antiga selecionada, ou uma batelada não foi contada.',
    todo: 'Confira a receita selecionada em cada bico ao trocar de produto, e o contador de bateladas do misturador.',
  },
  unlinked: {
    scene: [
      { icon: <TagIcon />, text: 'receita do bico', tone: 'bag' },
      '→',
      { icon: <Question />, text: 'sem produto', tone: 'bad' },
      '→',
      { icon: <Bag />, text: 'fora das toneladas', tone: 'muted' },
    ],
    what: 'A receita que chegou do bico não está ligada a nenhum produto. Os sacos são contados, mas sem saber o peso do saco não viram toneladas.',
    todo: 'No aviso "Ver de onde vieram", ligue a receita ao produto. A plataforma sugere qual era, pelo misturador.',
  },
  noProduct: {
    scene: [
      { icon: <Scale />, text: 'receita do misturador', tone: 'mix' },
      '→',
      { icon: <Question />, text: 'sem produto', tone: 'bad' },
    ],
    what: 'O misturador fez uma receita que não está ligada a nenhum produto: não dá para seguir essa massa até os sacos.',
    todo: 'Em Produtos e receitas, ligue a receita do misturador ao produto.',
  },
  notBagged: {
    scene: [
      { icon: <Scale />, text: 'misturou o produto', tone: 'mix' },
      '→',
      { icon: <Bag />, text: 'nenhum saco com esse nome', tone: 'bad' },
    ],
    what: 'O misturador fez o produto, mas nenhum saco saiu com o nome dele: os bicos estavam com a receita de outro produto durante essa mistura.',
    todo: 'Confira a receita selecionada nos bicos quando o misturador muda de produto.',
  },
  wrongName: {
    scene: [
      { icon: <Scale />, text: 'pouca massa', tone: 'mix' },
      '→',
      { icon: <Bag />, text: 'muitos sacos', tone: 'bad' },
    ],
    what: 'Saíram muito mais sacos do que a massa misturada daria: esses sacos não eram desta mistura, estavam com o nome errado no bico.',
    todo: 'Confira a receita selecionada nos bicos.',
  },
  changeover: {
    scene: [
      { icon: <Bag />, text: 'produto A', tone: 'bag' },
      '⇄',
      { icon: <Bag />, text: 'produto B', tone: 'mix' },
    ],
    what: 'Na troca de produto, o silo ainda solta o produto anterior enquanto o bico já está com o nome do novo (ou o contrário). Alguns sacos são contados no produto vizinho: um lado falta, o outro sobra, e no total se compensam.',
    todo: 'Troque a receita dos bicos quando o silo esvaziar do produto anterior.',
  },
  bagWeight: {
    scene: [
      { icon: <Scale />, text: 'massa da balança', tone: 'mix' },
      '→',
      { icon: <Bag />, text: '÷ número de sacos', tone: 'bag' },
    ],
    what: 'Massa misturada ÷ número de sacos = o peso real médio de cada saco. Abaixo do peso do saco (17 kg num saco de 20 kg) estão saindo sacos leves: mais sacos do que a massa permite. Até 4 % acima é o enchimento normal.',
    todo: 'Confira o peso de corte da ensacadeira para esses produtos, e a balança do misturador.',
    ruler: true,
  },
  loss: {
    scene: [
      { icon: <Scale />, text: 'misturado', tone: 'mix' },
      '→',
      { icon: <Drop />, text: 'limpeza, purga, descarte', tone: 'bad' },
    ],
    what: 'Massa que não virou saco, além do enchimento normal: limpeza da linha, purga, material descartado ou que ficou retido.',
    todo: 'Veja limpeza, purga e descarte do período. Se for constante, vale medir.',
  },
};

const ORDER: Group[] = ['normal', 'data', 'plant'];
const signed = (kg: number) =>
  `${kg > 0.5 ? '+' : kg < -0.5 ? '−' : ''}${Math.abs(kg) >= 1000 ? `${tons(Math.abs(kg))} t` : `${integer(Math.abs(kg))} kg`}`;
const brDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

function Scene({ steps }: { steps: Array<Step | Joint> }) {
  return (
    <div className="guide-scene" aria-hidden="true">
      {steps.map((step, index) =>
        typeof step === 'string' ? (
          <span key={index} className={`guide-joint ${step === '≠' ? 'not' : ''}`}>
            {step}
          </span>
        ) : (
          <span key={index} className={`guide-step ${step.tone ?? ''}`}>
            <i>{step.icon}</i>
            <small>{step.text}</small>
          </span>
        ),
      )}
    </div>
  );
}

function GuideCard({ kind, value }: { kind: BridgeKind; value?: number }) {
  const info = KINDS[kind];
  const group = GROUPS[info.group];
  const guide = GUIDE[kind];
  return (
    <article
      className={`guide-card${value == null ? ' quiet' : ''}`}
      style={{ '--why': group.color } as React.CSSProperties}
    >
      <header>
        <span className="why-icon">{info.icon}</span>
        <div>
          <b>{info.label}</b>
          <small>{group.title}</small>
        </div>
        {value != null && (
          <em title="No período aberto no card, na conta da diferença">
            {signed(value)}
            <small>{value > 0 ? 'faltou saco' : value < 0 ? 'saco a mais' : 'se compensa'}</small>
          </em>
        )}
      </header>
      <Scene steps={guide.scene} />
      {guide.ruler && (
        <div className="guide-ruler">
          <BagRuler real={17.1} nominal={20} />
          <small>exemplo: saco leve</small>
        </div>
      )}
      <p>{guide.what}</p>
      <div className="guide-todo">
        <span aria-hidden="true">→</span>
        {guide.todo}
      </div>
    </article>
  );
}

export function YieldGuide({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const data = recallReconcile(deviceId);
  // Each line's weight in the sum (+ bags missing, − bags in excess), as the card shows it.
  const present = new Map<BridgeKind, number>(
    (data?.bridge ?? []).filter((item) => Math.abs(item.kg) >= 50 || item.kind === 'changeover').map((item) => [item.kind, -item.kg]),
  );
  const kinds = Object.keys(GUIDE) as BridgeKind[];
  const now = kinds.filter((kind) => present.has(kind));
  const others = kinds.filter((kind) => !present.has(kind));
  const period = data ? (data.from === data.to ? `de ${brDay(data.from)}` : `de ${brDay(data.from)} a ${brDay(data.to)}`) : '';
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card guide-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-title">
          <div>
            <div className="eyebrow">COLINHA DO RENDIMENTO</div>
            <h2>Como ler a conta</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="guide-path" aria-label="O caminho da massa">
          <div className="guide-station mix">
            <i>
              <Scale />
            </i>
            <b>Misturador</b>
            <small>a balança pesa cada batelada</small>
          </div>
          <span className="guide-flow" aria-hidden="true" />
          <div className="guide-station silo">
            <i>
              <SiloIcon />
            </i>
            <b>Silo pulmão</b>
            <small>a massa espera horas, às vezes de um dia para o outro</small>
          </div>
          <span className="guide-flow" aria-hidden="true" />
          <div className="guide-station bag">
            <i>
              <Bag />
            </i>
            <b>Ensacadeira</b>
            <small>os bicos contam os sacos × o peso de cada saco</small>
          </div>
        </section>
        <p className="guide-lead">
          <b>Misturado</b> é o que a balança pesou; <b>ensacado</b> é o que os bicos contaram. A{' '}
          <b>diferença</b> é tudo o que fez os dois não baterem, e cada linha da conta é um motivo:
        </p>
        <div className="guide-signs">
          <span className="more">
            <b>+</b> faltou saco <small>a massa não virou saco (ainda)</small>
          </span>
          <span className="less">
            <b>−</b> saco a mais <small>saíram mais sacos do que a massa do período</small>
          </span>
        </div>
        <div className="guide-groups">
          {ORDER.map((group) => (
            <span key={group} style={{ '--why': GROUPS[group].color } as React.CSSProperties}>
              <i>{GROUPS[group].icon}</i>
              <b>{GROUPS[group].title}</b>
              <small>
                {group === 'normal'
                  ? 'não é problema: tempo do silo'
                  : group === 'data'
                    ? 'IHM ou cadastro a corrigir'
                    : 'processo a conferir na fábrica'}
              </small>
            </span>
          ))}
        </div>

        {now.length > 0 && (
          <>
            <div className="guide-section">Na conta {period}</div>
            <div className="guide-cards">
              {now.map((kind) => (
                <GuideCard key={kind} kind={kind} value={present.get(kind)} />
              ))}
            </div>
          </>
        )}
        <div className="guide-section">{now.length ? 'Outros itens que podem aparecer' : 'Os itens da conta'}</div>
        <div className="guide-cards">
          {others.map((kind) => (
            <GuideCard key={kind} kind={kind} />
          ))}
        </div>
      </div>
    </div>
  );
}
