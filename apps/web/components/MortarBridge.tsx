'use client';

import { useState, type ReactNode } from 'react';
import { usePoll } from './data';
import { integer, tons } from './mortarShared';

/**
 * Why mixed and bagged differ, read at a glance (API mortar/reconcile, mortar-reconcile.ts).
 *
 * The plant's people are not analysts: the difference is drawn, not written. Its causes are
 * sorted by who acts on them -- normal (mass on its way through the silo), data to fix (the HMI,
 * the catalog) and the plant to check (the bag's cut weight, the losses) -- each a column with
 * its colour, icon and total. A cause is one line: an icon, two or three words, its weight, a bar
 * that grows right when it added bags and left when it took them, and the days of the period it
 * happened on. Words come only when a line is opened, as short lines of date, product and weight;
 * the bag's weight is drawn as a ruler (real against nominal).
 */

export type BridgeKind =
  | 'carryIn'
  | 'carryOut'
  | 'silo'
  | 'offline'
  | 'notBagged'
  | 'changeover'
  | 'wrongName'
  | 'bagWeight'
  | 'loss'
  | 'noProduct'
  | 'unassigned'
  | 'unlinked';
export type BridgeSource = { campaign?: string; label: string | null; at: string; kg: number; note?: string };
export type ReconcileData = {
  from: string;
  to: string;
  mixedKg: number;
  baggedKg: number;
  bridge: Array<{ kind: BridgeKind; kg: number; sources: BridgeSource[] }>;
  unlinked: Array<{
    recipe: string;
    bags: number;
    bagsInPeriod: number;
    inferred: Array<{ product: string; bags: number }>;
    first: string;
    last: string;
  }>;
};

type Group = 'normal' | 'data' | 'plant';
const GROUPS: Record<Group, { title: string; hint: string; color: string; icon: ReactNode }> = {
  normal: {
    title: 'Normal',
    hint: 'massa a caminho no silo',
    color: '#6f8fb3',
    icon: <Icon d="M5 12l4 4 10-10" />,
  },
  data: {
    title: 'Corrigir dados',
    hint: 'IHM e cadastro',
    color: '#d39a2f',
    icon: <Icon d="M12 8v5M12 16.5v.5M10.3 3.9L2.5 17.5a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />,
  },
  plant: {
    title: 'Conferir na fábrica',
    hint: 'processo e ensacadeira',
    color: '#d8664a',
    icon: <Icon d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.5-.5-.5-2.5 2.5-2.5z" />,
  },
};

const KINDS: Record<BridgeKind, { label: string; group: Group; why: string; icon: ReactNode }> = {
  carryIn: { label: 'Veio do silo', group: 'normal', why: 'Misturado antes do período, ensacado nele.', icon: <SiloIcon /> },
  carryOut: { label: 'Ficou no silo', group: 'normal', why: 'Misturado no período, ensacado depois.', icon: <SiloIcon /> },
  silo: { label: 'Ainda no silo', group: 'normal', why: 'Ainda está saindo em sacos.', icon: <SiloIcon /> },
  offline: {
    label: 'IHM sem sinal',
    group: 'data',
    why: 'A IHM ficou sem sinal e mandou tudo junto depois, com o horário errado.',
    icon: <Icon d="M2 8.5a15 15 0 0120 0M5 12a10 10 0 0114 0M8.5 15.5a5 5 0 017 0M12 19h.01M3 3l18 18" />,
  },
  unassigned: {
    label: 'Saco sem mistura',
    group: 'data',
    why: 'Saco com o nome de um produto que não estava sendo misturado.',
    icon: <TagIcon />,
  },
  unlinked: {
    label: 'Sem produto',
    group: 'data',
    why: 'Receita do bico sem produto: o saco fica fora das toneladas.',
    icon: <TagIcon />,
  },
  noProduct: {
    label: 'Mistura sem produto',
    group: 'data',
    why: 'Receita do misturador sem produto.',
    icon: <TagIcon />,
  },
  notBagged: {
    label: 'Mistura sem saco',
    group: 'data',
    why: 'Misturado, mas nenhum saco saiu com esse nome.',
    icon: <TagIcon />,
  },
  wrongName: {
    label: 'Nome errado no bico',
    group: 'data',
    why: 'Saco demais para a massa: não era deste produto.',
    icon: <TagIcon />,
  },
  changeover: {
    label: 'Troca de produto',
    group: 'plant',
    why: 'Na troca, sacos contados no produto vizinho.',
    icon: <Icon d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />,
  },
  bagWeight: {
    label: 'Peso do saco',
    group: 'plant',
    why: 'Saco saindo mais leve ou mais pesado que o nominal.',
    icon: <Icon d="M6 8h12l1.5 12h-15zM9 8a3 3 0 016 0" />,
  },
  loss: {
    label: 'Perda',
    group: 'plant',
    why: 'Massa que não virou saco: limpeza, purga, descarte.',
    icon: <Icon d="M12 3c3 4 6 7.5 6 11a6 6 0 01-12 0c0-3.5 3-7 6-11z" />,
  },
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
function SiloIcon() {
  return <Icon d="M6 5a6 2 0 0112 0v11l-3 4H9l-3-4zM6 5a6 2 0 0012 0M10 20v1.5M14 20v1.5" />;
}
function TagIcon() {
  return <Icon d="M3 12V4h8l9 9-8 8zM7.5 7.5h.01" />;
}

const brDay = (iso: string) => {
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
};
const plantDay = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
/** Tons from one ton up, kilos under it. */
const weight = (kg: number) =>
  Math.abs(kg) >= 1000 ? `${tons(Math.abs(kg))} t` : `${integer(Math.abs(kg))} kg`;
const signed = (kg: number) => `${kg > 0.5 ? '+' : kg < -0.5 ? '−' : ''}${weight(kg)}`;
function daysOf(from: string, to: string) {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T12:00:00Z`); at <= Date.parse(`${to}T12:00:00Z`) && days.length < 62; at += 86_400_000)
    days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

/** The bag's real weight against its nominal one, as a ruler. */
function BagRuler({ real, nominal }: { real: number; nominal: number }) {
  const low = nominal * 0.8;
  const high = nominal * 1.1;
  const at = (kg: number) => `${((Math.min(high, Math.max(low, kg)) - low) / (high - low)) * 100}%`;
  const off = (real - nominal) / nominal;
  const tone = Math.abs(off) <= 0.03 ? 'ok' : off < 0 ? 'light' : 'heavy';
  return (
    <span className={`bag-ruler ${tone}`} title={`${real.toFixed(1)} kg por saco, nominal ${nominal} kg`}>
      <span className="bag-ruler-track">
        <i className="nominal" style={{ left: at(nominal) }} />
        <i className="fill" style={{ left: at(Math.min(real, nominal)), width: `calc(${at(Math.max(real, nominal))} - ${at(Math.min(real, nominal))})` }} />
        <u style={{ left: at(real) }} />
      </span>
      <b>{real.toFixed(1).replace('.', ',')} kg</b>
      <small>de {nominal} kg</small>
    </span>
  );
}

/** A line's detail: date, product and weight -- or the ruler, for the bag weight. */
function SourceLine({ kind, source }: { kind: BridgeKind; source: BridgeSource }) {
  const when = source.note && /^\d{4}-\d{2}-\d{2}$/.test(source.note) ? brDay(`${source.note}T15:00:00Z`) : brDay(source.at);
  const [real, nominal] = kind === 'bagWeight' ? (source.note ?? '').split('|').map(Number) : [];
  return (
    <li>
      <em>{source.note === 'before' ? 'antes' : when}</em>
      <span>
        {source.label ?? 'sem produto'}
        {kind === 'changeover' && source.note && <small> ⇄ {source.note}</small>}
      </span>
      {real && nominal ? <BagRuler real={real} nominal={nominal} /> : <i />}
      <b className={source.kg < 0 ? 'minus' : 'plus'}>{signed(source.kg)}</b>
    </li>
  );
}

/** The period's causes, by who acts on them. */
export function PeriodBridge({
  data,
  head = true,
}: {
  data: ReconcileData;
  /** The card above already shows mixed, bagged and the difference: only the causes. */
  head?: boolean;
}) {
  const [open, setOpen] = useState<BridgeKind | null>(null);
  const difference = data.baggedKg - data.mixedKg;
  const share = data.mixedKg ? data.baggedKg / data.mixedKg : null;
  const days = daysOf(data.from, data.to);
  const peak = Math.max(1, ...data.bridge.map((item) => Math.abs(item.kg)));
  const groups = (Object.keys(GROUPS) as Group[])
    .map((group) => ({
      group,
      items: data.bridge
        .filter((item) => KINDS[item.kind].group === group)
        .sort((a, b) => Math.abs(b.kg) - Math.abs(a.kg)),
    }))
    .filter((entry) => entry.items.length);
  return (
    <section className="why">
      {head && (
      <header className="why-head">
        <div className={`why-close ${share != null && Math.abs(1 - share) <= 0.02 ? 'ok' : 'off'}`}>
          <b>{share == null ? '—' : `${(share * 100).toFixed(1).replace('.', ',')}%`}</b>
          <span>do misturado virou saco</span>
        </div>
        <p>
          {Math.abs(difference) < 1 ? (
            'Cada quilo misturado saiu em sacos.'
          ) : (
            <>
              <b>{weight(difference)}</b> {difference < 0 ? 'a menos' : 'a mais'} em sacos. Veja o que explica:
            </>
          )}
        </p>
      </header>
      )}
      <div className="why-groups">
        {groups.map(({ group, items }) => {
          const info = GROUPS[group];
          const total = items.reduce((sum, item) => sum + item.kg, 0);
          return (
            <div key={group} className="why-group" style={{ '--why': info.color } as React.CSSProperties}>
              <div className="why-group-head">
                <span className="why-group-icon">{info.icon}</span>
                <div>
                  <b>{info.title}</b>
                  <small>{info.hint}</small>
                </div>
                <strong>{signed(total)}</strong>
              </div>
              <ul>
                {items.map((item) => {
                  const kind = KINDS[item.kind];
                  const marked = new Set(item.sources.map((source) => (source.note && /^\d{4}/.test(source.note) ? source.note : plantDay(source.at))));
                  const opened = open === item.kind;
                  const evened = item.kind === 'changeover' && Math.abs(item.kg) < 50;
                  return (
                    <li key={item.kind} className={opened ? 'open' : ''}>
                      <button type="button" onClick={() => setOpen(opened ? null : item.kind)} aria-expanded={opened}>
                        <span className="why-icon">{kind.icon}</span>
                        <span className="why-label">{kind.label}</span>
                        <span className="why-bar" aria-hidden="true">
                          <i
                            className={item.kg < 0 ? 'minus' : 'plus'}
                            style={{ width: `${Math.max(4, (Math.abs(item.kg) / peak) * 50)}%` }}
                          />
                        </span>
                        <b className={evened ? 'even' : item.kg < 0 ? 'minus' : 'plus'}>
                          {evened ? '⇄ zero' : signed(item.kg)}
                        </b>
                        {days.length > 1 && (
                          <span className="why-days" aria-label="Dias em que aconteceu">
                            {days.map((day) => (
                              <i key={day} className={marked.has(day) ? 'on' : ''} title={brDay(`${day}T15:00:00Z`)} />
                            ))}
                          </span>
                        )}
                      </button>
                      {opened && (
                        <div className="why-detail">
                          <p>{kind.why}</p>
                          <ul>
                            {item.sources.slice(0, 10).map((source, index) => (
                              <SourceLine key={index} kind={item.kind} source={source} />
                            ))}
                          </ul>
                          {item.sources.length > 10 && <small>e mais {item.sources.length - 10}</small>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function useReconcile(deviceId: string | null | undefined, from: string, to: string) {
  return usePoll<ReconcileData>(
    deviceId ? `/devices/${deviceId}/mortar/reconcile?from=${from}&to=${to}` : null,
    300000,
  );
}

/** A campaign of lots: what the scale weighed, what left in bags, and why they differ. */
export type CampaignData = {
  id: string;
  mix: string | null;
  products: string[];
  nominalKg: number | null;
  lots: string[];
  batches: number;
  mixedKg: number;
  recipeKg: number;
  bags: number;
  baggedKg: number;
  startedAt: string;
  lastBatchAt: string;
  firstBagAt: string | null;
  lastBagAt: string | null;
  offline: boolean;
  open: boolean;
  causes: Array<{ kind: BridgeKind; kg: number; partner?: string; realBagKg?: number; nominalKg?: number }>;
};

export function CampaignBridge({ campaign }: { campaign: CampaignData }) {
  const difference = campaign.baggedKg - campaign.mixedKg;
  const dosed = campaign.mixedKg - campaign.recipeKg;
  const peak = Math.max(1, ...campaign.causes.map((cause) => Math.abs(cause.kg)));
  return (
    <section className="why campaign">
      <div className="why-equation">
        <div>
          <span className="why-icon">
            <Icon d="M4 20h16M7 20V10h10v10M12 10V4M8 6h8" />
          </span>
          <small>Na balança</small>
          <b>{weight(campaign.mixedKg)}</b>
          <em>
            {campaign.batches} {campaign.batches === 1 ? 'batelada' : 'bateladas'}
            {Math.abs(dosed) >= 1 && ` · ${dosed > 0 ? '+' : '−'}${integer(Math.abs(dosed))} kg da receita`}
          </em>
        </div>
        <span className="why-arrow" aria-hidden="true">→</span>
        <div>
          <span className="why-icon">
            <Icon d="M6 8h12l1.5 12h-15zM9 8a3 3 0 016 0" />
          </span>
          <small>Em sacos</small>
          <b>{weight(campaign.baggedKg)}</b>
          <em>{integer(campaign.bags)} sacos</em>
        </div>
        <span className="why-arrow" aria-hidden="true">=</span>
        <div className={Math.abs(difference) <= campaign.mixedKg * 0.02 ? 'ok' : difference < 0 ? 'minus' : 'plus'}>
          <small>{Math.abs(difference) <= campaign.mixedKg * 0.02 ? 'Fechou' : difference < 0 ? 'Faltou' : 'Sobrou'}</small>
          <b>{signed(difference)}</b>
          <em>
            {campaign.lots.length} {campaign.lots.length === 1 ? 'lote' : 'lotes'} de {campaign.mix ?? 'sem produto'}
          </em>
        </div>
      </div>
      {campaign.causes.length > 0 && (
        <ul className="why-causes">
          {campaign.causes.map((cause, index) => {
            const kind = KINDS[cause.kind];
            const group = GROUPS[kind.group];
            return (
              <li key={index} style={{ '--why': group.color } as React.CSSProperties}>
                <span className="why-icon">{kind.icon}</span>
                <span className="why-label">
                  {kind.label}
                  <small>{group.title}</small>
                </span>
                {cause.kind === 'bagWeight' && cause.realBagKg && cause.nominalKg ? (
                  <BagRuler real={cause.realBagKg} nominal={cause.nominalKg} />
                ) : cause.kind === 'changeover' && cause.partner ? (
                  <span className="why-partner">⇄ {cause.partner}</span>
                ) : (
                  <span className="why-bar" aria-hidden="true">
                    <i className={cause.kg < 0 ? 'minus' : 'plus'} style={{ width: `${Math.max(4, (Math.abs(cause.kg) / peak) * 50)}%` }} />
                  </span>
                )}
                <b className={cause.kg < 0 ? 'minus' : 'plus'}>{signed(cause.kg)}</b>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
