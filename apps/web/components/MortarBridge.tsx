'use client';

import { useState } from 'react';
import { usePoll } from './data';
import { integer, tons } from './mortarShared';

/**
 * From mixed to bagged, step by step (API mortar/reconcile, apps/api/src/mortar-reconcile.ts).
 *
 * The platform follows every bag back to the batches it came from and says why each kilo of
 * difference exists. Drawn as a horizontal waterfall on one scale: the mixed mass, one step per
 * cause, the bagged mass. A step opens to what makes it, with its dates. The colours tell who
 * acts on it: the silo is only time; the HMI and the catalog are data to fix; the process is the
 * plant (the bag's cut weight, the losses).
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

type Family = 'silo' | 'data' | 'process';
export const FAMILIES: Record<Family, { label: string; color: string }> = {
  silo: { label: 'Silo (só tempo)', color: '#7f9bb8' },
  data: { label: 'IHM e cadastro', color: '#d9a441' },
  process: { label: 'Processo', color: '#e07a5f' },
};

/** How each step is named inside a sentence ("o que mais pesa são os sacos sem batelada"). */
const PHRASES: Record<BridgeKind, string> = {
  carryIn: 'é o silo do começo do período',
  carryOut: 'é o silo do fim do período',
  silo: 'é o que ainda está no silo',
  offline: 'é a IHM offline',
  unassigned: 'são os sacos sem batelada',
  unlinked: 'são as receitas sem produto',
  noProduct: 'é o misturador sem produto',
  notBagged: 'é a mistura que saiu sem saco',
  changeover: 'é a troca de produto',
  wrongName: 'é o nome errado no bico',
  bagWeight: 'é o peso real do saco',
  loss: 'é a perda',
};

export const KINDS: Record<BridgeKind, { title: string; family: Family; why: string }> = {
  carryIn: {
    title: 'Silo no começo',
    family: 'silo',
    why: 'Ensacado no período, mas misturado antes dele.',
  },
  carryOut: {
    title: 'Silo no fim',
    family: 'silo',
    why: 'Misturado no período, mas ensacado depois dele.',
  },
  silo: {
    title: 'Ainda no silo',
    family: 'silo',
    why: 'A campanha atual ainda está saindo em sacos.',
  },
  offline: {
    title: 'IHM offline',
    family: 'data',
    why: 'A IHM ficou sem enviar e mandou tudo de uma vez quando voltou: bateladas e sacos chegaram com o horário errado, então nesse trecho não dá para casar um com o outro.',
  },
  unassigned: {
    title: 'Sacos sem batelada',
    family: 'data',
    why: 'Sacos com o nome de um produto que o misturador não estava fazendo: nome errado no bico, ou batelada que o contador não registrou.',
  },
  unlinked: {
    title: 'Receitas sem produto',
    family: 'data',
    why: 'Sacos de receitas que não estão ligadas a um produto: contados, mas fora das toneladas.',
  },
  noProduct: {
    title: 'Misturador sem produto',
    family: 'data',
    why: 'Bateladas de uma receita do misturador que não está ligada a um produto: a massa não tem como ser seguida até os sacos.',
  },
  notBagged: {
    title: 'Mistura sem saco',
    family: 'data',
    why: 'O misturador fez o produto, mas nenhum saco saiu com esse nome: os bicos estavam com a receita de outro produto.',
  },
  changeover: {
    title: 'Troca de produto',
    family: 'process',
    why: 'Na troca, o silo ainda soltava o produto anterior enquanto os bicos já tinham o nome do novo (ou o contrário): os sacos foram contados no produto errado. Os dois lados se compensam.',
  },
  wrongName: {
    title: 'Nome errado no bico',
    family: 'data',
    why: 'Saíram muito mais sacos do que a massa dá: esses sacos não eram desta mistura.',
  },
  bagWeight: {
    title: 'Peso real do saco',
    family: 'process',
    why: 'Massa da balança ÷ sacos. Abaixo do peso nominal, os sacos estão saindo leves: confira o peso de corte da ensacadeira. Um pouco acima é o enchimento normal.',
  },
  loss: {
    title: 'Perda',
    family: 'process',
    why: 'Massa que não virou saco além do enchimento normal: limpeza, purga, descarte ou sobra no silo.',
  },
};
const ORDER: BridgeKind[] = [
  'carryIn',
  'carryOut',
  'silo',
  'offline',
  'unassigned',
  'unlinked',
  'noProduct',
  'notBagged',
  'changeover',
  'wrongName',
  'bagWeight',
  'loss',
];

const day = (iso: string) => {
  const local = new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
};
/** Tons from one ton up, kilos under it: "+598 kg" reads better than "+0,598 t". */
const signed = (kg: number) =>
  `${kg > 0 ? '+' : kg < 0 ? '−' : ''}${Math.abs(kg) >= 1000 ? `${tons(Math.abs(kg))} t` : `${integer(Math.abs(kg))} kg`}`;

/** One line of where a step comes from, in words. */
function sourceText(kind: BridgeKind, source: BridgeSource) {
  const name = source.label ?? 'sem produto';
  const when = source.note && /^\d{4}-\d{2}-\d{2}$/.test(source.note) ? day(`${source.note}T15:00:00Z`) : day(source.at);
  switch (kind) {
    case 'carryIn':
      return source.note === 'before'
        ? `${name}: sacos de antes da primeira batelada registrada (silo anterior ao monitoramento)`
        : `${name}: misturado em ${when}, ensacado no período`;
    case 'carryOut':
      return `${name}: misturado em ${when}, ensacado depois do período`;
    case 'silo':
      return `${name}: campanha de ${when} ainda saindo em sacos`;
    case 'offline':
      return source.campaign
        ? `${name} · ${when}: bateladas chegaram juntas quando a IHM voltou`
        : `${name} · ${when}: sacos chegaram com o horário do reenvio`;
    case 'unassigned':
      return `${name} · ${when}: sacos com esse nome sem batelada desse produto no misturador`;
    case 'unlinked':
      return `Receita “${name}” sem produto`;
    case 'noProduct':
      return `${name} · ${when}: receita do misturador sem produto`;
    case 'notBagged':
      return `${name} · ${when}: nenhum saco saiu com esse nome`;
    case 'changeover':
      return `${name} · ${when}: troca com ${source.note ?? 'o produto vizinho'}`;
    case 'wrongName':
      return `${name} · ${when}: sacos demais para a massa misturada`;
    case 'bagWeight': {
      const [real, nominal] = (source.note ?? '').split('|');
      return real
        ? `${name} · ${when}: sacos de ${real.replace('.', ',')} kg em média (nominal ${nominal} kg)`
        : `${name} · ${when}`;
    }
    case 'loss':
      return `${name} · ${when}: massa que não virou saco`;
  }
}

export type BridgeRow = {
  key: string;
  kind: BridgeKind;
  kg: number;
  /** Shown under the row when opened. */
  lines: Array<{ text: string; kg: number }>;
};

/** The waterfall itself: any start, steps and end on one scale. */
export function Bridge({
  start,
  end,
  rows,
}: {
  start: { label: string; kg: number };
  end: { label: string; kg: number };
  rows: BridgeRow[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  // Running totals: each step floats from where the last one ended.
  let running = start.kg;
  const steps = rows.map((row) => {
    const from = running;
    running += row.kg;
    return { row, from, to: running };
  });
  const values = [start.kg, end.kg, ...steps.flatMap((step) => [step.from, step.to])];
  const high = Math.max(...values);
  const low = Math.min(...values);
  // The axis starts below the lowest total (marked as broken) so small steps stay readable.
  const pad = Math.max((high - low) * 0.35, high * 0.01);
  const floor = Math.max(0, low - pad);
  const top = high + pad * 0.15;
  const at = (kg: number) => `${((kg - floor) / (top - floor)) * 100}%`;
  const width = (a: number, b: number) => `${(Math.abs(b - a) / (top - floor)) * 100}%`;
  const broken = floor > 0;
  const scaleNote = broken ? `escala a partir de ${tons(floor)} t` : undefined;
  return (
    <div className="mb-chart" role="table" aria-label="Do misturado ao ensacado">
      <div className="mb-row total" role="row">
        <span className="mb-label">{start.label}</span>
        <span className="mb-track">
          <i className="mb-bar mixed" style={{ left: 0, width: at(start.kg) }} title={scaleNote} />
        </span>
        <b className="mb-value">{tons(start.kg)} t</b>
      </div>
      {steps.map(({ row, from, to }) => {
        const info = KINDS[row.kind];
        const color = FAMILIES[info.family].color;
        const opened = open === row.key;
        return (
          <div key={row.key} className={`mb-step${opened ? ' open' : ''}`}>
            <button
              type="button"
              className="mb-row"
              role="row"
              aria-expanded={opened}
              onClick={() => setOpen(opened ? null : row.key)}
            >
              <span className="mb-label">
                <u style={{ background: color }} />
                {info.title}
                <em aria-hidden="true">›</em>
              </span>
              <span className="mb-track">
                <i className="mb-guide" style={{ left: at(Math.min(from, to)) }} />
                <i
                  className="mb-bar"
                  style={{
                    left: at(Math.min(from, to)),
                    width: width(from, to),
                    background: color,
                    opacity: row.kg < 0 ? 0.55 : 1,
                  }}
                />
              </span>
              <b className={`mb-value ${row.kg < 0 ? 'minus' : row.kg > 0 ? 'plus' : ''}`}>
                {Math.abs(row.kg) < 50 && row.kind === 'changeover' ? 'se compensam' : signed(row.kg)}
              </b>
            </button>
            {opened && (
              <div className="mb-detail">
                <p>{info.why}</p>
                {row.lines.length > 0 && (
                  <ul>
                    {row.lines.slice(0, 8).map((line, index) => (
                      <li key={index}>
                        <span>{line.text}</span>
                        <b>{signed(line.kg)}</b>
                      </li>
                    ))}
                    {row.lines.length > 8 && <li className="more">e mais {row.lines.length - 8}</li>}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="mb-row total" role="row">
        <span className="mb-label">{end.label}</span>
        <span className="mb-track">
          <i className="mb-bar bagged" style={{ left: 0, width: at(end.kg) }} title={scaleNote} />
        </span>
        <b className="mb-value">{tons(end.kg)} t</b>
      </div>
      <div className="mb-legend">
        {(Object.keys(FAMILIES) as Family[])
          .filter((family) => rows.some((row) => KINDS[row.kind].family === family))
          .map((family) => (
            <span key={family}>
              <u style={{ background: FAMILIES[family].color }} />
              {FAMILIES[family].label}
            </span>
          ))}
        {scaleNote && <span className="mb-scale">{scaleNote}</span>}
      </div>
    </div>
  );
}

export function useReconcile(deviceId: string | null | undefined, from: string, to: string) {
  return usePoll<ReconcileData>(
    deviceId ? `/devices/${deviceId}/mortar/reconcile?from=${from}&to=${to}` : null,
    300000,
  );
}

/** The period's bridge, for the yield card: a sentence, then the steps. */
export function PeriodBridge({ data }: { data: ReconcileData }) {
  const difference = data.baggedKg - data.mixedKg;
  const rows: BridgeRow[] = ORDER.flatMap((kind) => {
    const item = data.bridge.find((entry) => entry.kind === kind);
    if (!item) return [];
    return [
      {
        key: kind,
        kind,
        kg: item.kg,
        lines: item.sources.map((source) => ({ text: sourceText(kind, source), kg: source.kg })),
      },
    ];
  });
  const biggest = [...rows].sort((a, b) => Math.abs(b.kg) - Math.abs(a.kg))[0];
  return (
    <section className="mb">
      <header className="mb-head">
        <span>De onde vem a diferença</span>
        <p>
          Das <b>{tons(data.mixedKg)} t</b> misturadas saíram <b>{tons(data.baggedKg)} t</b> em sacos
          {Math.abs(difference) >= 1 ? (
            <>
              : <b>{tons(Math.abs(difference))} t</b> {difference < 0 ? 'a menos' : 'a mais'}.
            </>
          ) : (
            '.'
          )}{' '}
          {rows.length
            ? `A plataforma seguiu cada saco até a batelada de onde veio${biggest ? `; o que mais pesa ${PHRASES[biggest.kind]}` : ''}. Toque numa linha para ver quando e onde.`
            : 'Cada saco fechou com a sua batelada.'}
        </p>
      </header>
      {rows.length > 0 && (
        <Bridge
          start={{ label: 'Misturado', kg: data.mixedKg }}
          end={{ label: 'Ensacado', kg: data.baggedKg }}
          rows={rows}
        />
      )}
    </section>
  );
}

/** A campaign's own steps, for the lot window. */
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

export function causeText(cause: CampaignData['causes'][number], campaign: CampaignData) {
  switch (cause.kind) {
    case 'bagWeight':
      return cause.realBagKg
        ? `Os sacos saíram com ${cause.realBagKg.toFixed(1).replace('.', ',')} kg em média, para um saco de ${cause.nominalKg} kg.`
        : KINDS.bagWeight.why;
    case 'changeover':
      return `Na troca com ${cause.partner ?? 'o produto vizinho'}, ${cause.kg > 0 ? 'sacos do outro produto saíram com o nome deste' : 'sacos deste produto saíram com o nome do outro'}.`;
    case 'silo':
      return `A campanha ainda está saindo em sacos: ${tons(-cause.kg)} t seguem no silo.`;
    case 'offline':
      return 'A IHM ficou offline e mandou bateladas e sacos de uma vez: o horário se perdeu e não dá para fechar esta campanha.';
    case 'notBagged':
      return `Nenhum saco saiu com o nome de ${campaign.mix ?? 'este produto'}: os bicos estavam com outra receita.`;
    case 'loss':
      return 'Massa que não virou saco além do enchimento normal: limpeza, purga, descarte ou sobra no silo.';
    default:
      return KINDS[cause.kind].why;
  }
}

export function CampaignBridge({ campaign }: { campaign: CampaignData }) {
  const rows: BridgeRow[] = campaign.causes.map((cause, index) => ({
    key: `${cause.kind}-${index}`,
    kind: cause.kind,
    kg: cause.kg,
    lines: [{ text: causeText(cause, campaign), kg: cause.kg }],
  }));
  const dosed = campaign.mixedKg - campaign.recipeKg;
  return (
    <section className="mb">
      <header className="mb-head">
        <span>Por que a diferença</span>
        <p>
          Os lotes de um mesmo produto em sequência dividem o silo: a conta fecha na campanha de{' '}
          <b>{campaign.mix ?? 'sem produto'}</b> ({campaign.lots.length}{' '}
          {campaign.lots.length === 1 ? 'lote' : 'lotes'}, {day(campaign.startedAt)}).{' '}
          A balança pesou <b>{tons(campaign.mixedKg)} t</b>
          {Math.abs(dosed) >= 1 && (
            <>
              {' '}
              ({dosed > 0 ? '+' : '−'}
              {integer(Math.abs(dosed))} kg sobre a receita)
            </>
          )}{' '}
          e saíram <b>{integer(campaign.bags)} sacos</b>, {tons(campaign.baggedKg)} t.
        </p>
      </header>
      {rows.length > 0 ? (
        <Bridge
          start={{ label: 'Na balança', kg: campaign.mixedKg }}
          end={{ label: 'Em sacos', kg: campaign.baggedKg }}
          rows={rows}
        />
      ) : (
        <p className="mb-closed">A campanha fechou: cada quilo misturado saiu em sacos.</p>
      )}
    </section>
  );
}
