import { createContext } from 'react';

/**
 * What the mortar cards share: the summary the API returns (apps/api/src/mortar.ts), the
 * colours that mean the same thing on every card, and the way numbers are written.
 */
export type MortarView = 'bagging' | 'mortar_output' | 'mortar_materials' | 'mortar_yield';

export type SpoutState = 'running' | 'idle' | 'off' | 'offline' | 'unknown';
export type SpoutProduct = {
  recipe: string;
  product: string | null;
  bags: number;
  kg: number | null;
  runningS: number;
  secondsPerBag: number | null;
};
export type Spout = {
  id: string;
  position: number;
  name: string;
  state: SpoutState;
  recipe: string | null;
  product: string | null;
  lastBagAt: string | null;
  bags: number;
  kg: number;
  runningS: number;
  idleS: number;
  offS: number;
  bagsPerHour: number | null;
  secondsPerBag: number | null;
  products: SpoutProduct[];
  stops: number;
  stopSeconds: number;
  longestStop: number;
  performance: number | null;
};
export type BagSlot = {
  slot: string;
  bags: number;
  kg: number;
  spouts: Record<string, number>;
  running: Record<string, number>;
  idle: Record<string, number>;
  off: Record<string, number>;
};
export type MixRecipe = {
  recipe: string;
  batches: number;
  kg: number;
  lastAt: string | null;
  scaleKg: number | null;
  scaleTheoreticalKg: number;
  materials: Array<{ label: string; kg: number }>;
};
export type ProductRow = {
  key: string;
  productId: string | null;
  name: string;
  nominalKg: number | null;
  bags: number;
  kg: number | null;
  recipes: Array<{ recipe: string; bags: number }>;
  spouts: Record<string, number>;
};
export type Summary = {
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  modules: { mix: boolean; bagging: boolean };
  bagging: {
    totals: {
      bags: number;
      kg: number;
      unlinkedBags: number;
      runningS: number;
      idleS: number;
      offS: number;
    };
    spouts: Spout[];
    products: ProductRow[];
    series: BagSlot[];
  };
  mix: {
    batches: number;
    kg: number;
    scaleKg: number | null;
    scaleTheoreticalKg: number;
    lastBatchAt: string | null;
    cycleMinutes: number | null;
    /** What the raw materials cost, when prices are set (Ações → Produtos e receitas). */
    cost: null | {
      total: number;
      perTon: number | null;
      perBatch: number | null;
      missing: string[];
      materials: Array<{ label: string; pricePerTon: number | null; cost: number | null }>;
      byRecipe: Array<{ recipe: string; cost: number; perTon: number | null }>;
    };
    materials: Array<{ label: string; kg: number }>;
    recipes: MixRecipe[];
    series: Array<{ slot: string; batches: number; materials: Record<string, number> }>;
  };
  yield: {
    mixedKg: number;
    baggedKg: number;
    unlinkedBags: number;
    lossKg: number | null;
    lossRatio: number | null;
  };
};

export const SPOUT_COLORS = ['#12b8a6', '#3a7bd5', '#f2a93b', '#9b6bd3', '#e4572e', '#5aa469'];
export const MATERIAL_COLORS = ['#c9a36a', '#5f7d95', '#d9cdb4', '#5aa469', '#9b6bd3', '#f2a93b'];
export const PRODUCT_COLORS = [
  '#12b8a6',
  '#3a7bd5',
  '#f2a93b',
  '#9b6bd3',
  '#e4572e',
  '#5aa469',
  '#c9a36a',
  '#7a8fa6',
];
/** The same colours the ceramic boards use for the same states. */
export const STATES: Record<SpoutState, { label: string; color: string }> = {
  running: { label: 'Ensacando', color: '#12b8a6' },
  idle: { label: 'Ociosa', color: '#f2a93b' },
  off: { label: 'Desabilitada', color: '#98a6ab' },
  offline: { label: 'Sem comunicação', color: '#e4572e' },
  unknown: { label: 'Aguardando dados', color: '#c4d0d3' },
};

export const integer = (value: number) => Math.round(value).toLocaleString('pt-BR');
/**
 * Tons as the plant reads them. Under 1 t three places, so a small batch reads 0,400 t and not
 * 0,4; above it one place is enough and three would only be noise.
 */
export function tons(kg: number | null | undefined) {
  if (kg == null || !Number.isFinite(kg)) return '—';
  const places = Math.abs(kg) < 1000 ? 3 : 1;
  return (kg / 1000).toLocaleString('pt-BR', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}
export const kilos = (kg: number | null | undefined) =>
  kg == null || !Number.isFinite(kg) ? '—' : `${Math.round(kg).toLocaleString('pt-BR')} kg`;
export const percent = (value: number | null | undefined, places = 1) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : `${(value * 100).toLocaleString('pt-BR', { minimumFractionDigits: places, maximumFractionDigits: places })}%`;
export function duration(seconds: number) {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
    : `${minutes} min`;
}
/** "2026-10-01" → "01/10"; "2026-10-01T14" → "14h"; "2026-10-01T14:15" → "14:15". */
export const slotLabel = (slot: string) =>
  slot.length > 13
    ? slot.slice(11)
    : slot.includes('T')
      ? `${slot.slice(11)}h`
      : slot.split('-').reverse().slice(0, 2).join('/');
/** Seconds per bag as the plant reads it: "14,2 s". */
export const perBag = (seconds: number | null | undefined) =>
  seconds == null || !Number.isFinite(seconds)
    ? '—'
    : `${seconds.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
/** Money as the plant reads it: "R$ 1.234". */
export const money = (value: number | null | undefined, places = 0) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      });
export const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
/** "01/10" or "01/10 a 07/10": the period the card is reading, said once in every modal. */
export const periodText = (from: string, to: string) => {
  const day = (date: string) => date.split('-').reverse().slice(0, 2).join('/');
  return from === to ? day(from) : `${day(from)} a ${day(to)}`;
};

/** The dashboard's own period words, the same the stops card offers, plus yesterday. */
export type Period = 'today' | 'yesterday' | '7d' | 'week' | 'month' | 'year' | 'custom';
export const PERIODS: Array<[Period, string]> = [
  ['today', 'Hoje'],
  ['yesterday', 'Ontem'],
  ['7d', '7 dias'],
  ['week', 'Semana'],
  ['month', 'Mês'],
  ['year', 'Ano'],
  ['custom', 'Personalizado'],
];
export const isoDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
export function windowOf(period: Period): { from: string; to: string } {
  const now = new Date();
  const to = isoDay(now);
  const back = (days: number) => isoDay(new Date(now.getTime() - days * 86400000));
  if (period === 'today') return { from: to, to };
  if (period === 'yesterday') return { from: back(1), to: back(1) };
  if (period === '7d') return { from: back(6), to };
  if (period === 'week') return { from: back((now.getDay() + 6) % 7), to };
  if (period === 'month')
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  return { from: isoDay(new Date(now.getFullYear(), 0, 1)), to };
}

/**
 * The colours a mortar card draws with. They come from the card's own settings (the pencil):
 * the card colour, which starts as the White label primary, leads; each spout and each
 * material can be given its own, and what is not set falls back to the default palette.
 */
export type MortarCardConfig = {
  color?: string;
  spoutColors?: string[];
  materialColors?: Record<string, string>;
};
export type MortarPalette = {
  accent: string;
  spout: (index: number) => string;
  material: (label: string, index: number) => string;
};
export function paletteOf(config: MortarCardConfig | undefined): MortarPalette {
  const accent = config?.color || SPOUT_COLORS[0];
  return {
    accent,
    spout: (index) =>
      config?.spoutColors?.[index] ||
      (index === 0 ? accent : SPOUT_COLORS[index % SPOUT_COLORS.length]),
    material: (label, index) =>
      config?.materialColors?.[label] || MATERIAL_COLORS[index % MATERIAL_COLORS.length],
  };
}

/** The colours of the card being drawn (its pencil settings), shared by everything inside it. */
export const MortarColors = createContext<MortarPalette>(paletteOf(undefined));
