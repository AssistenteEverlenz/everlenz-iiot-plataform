'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { FormulaInput, type VariableOption } from './FormulaInput';
import { evaluateFormula, formulaError } from './formula';
import { Hint } from './Hint';
import { VariablesModal } from './VariablesModal';
import { mutate } from './data';

// The plant's block on the operations page. The same component draws it in the list and inside
// the editor, so what is arranged in the editor is exactly what the list shows. Like a dashboard
// card, it is an ordered list of blocks on a 12-column grid; each block is a platform number
// (produced, target, projection, pace, efficiency) or one of the plant's own formulas.

export type OperationMachine = {
  deviceId: string;
  deviceName: string;
  state: string;
  product: string | null;
  metric: 'milheiros' | 'tons' | 'blocks' | 'pallets';
  totals: { pieces: number; milheiros: number; pallets: number; tons: number };
  target: number | null;
  projection: number;
  pacePerHour: number;
  utilization: number | null;
  location: { city: string | null; state: string | null };
  readings: Record<string, number>;
};
export type ItemKind = 'produced' | 'target' | 'projection' | 'pace' | 'efficiency' | 'formula';
export type CardItem = {
  id: string;
  kind: ItemKind;
  label?: string;
  formula?: string;
  unit?: string;
  decimals?: number;
  colSpan: number;
  rowSpan: number;
};
export type CardConfig = { version: 2; greenPct: number; yellowPct: number; items: CardItem[] };

const COLUMNS = 12;
const MAX_ROWS = 6;
export const MAX_ITEMS = 16;
const METRICS = { milheiros: 'milheiros', tons: 't', blocks: 'peças', pallets: 'paletes' };
export const KIND_LABELS: Record<ItemKind, string> = {
  produced: 'Produzido hoje',
  target: 'Meta',
  projection: 'Projeção',
  pace: 'Ritmo',
  efficiency: 'Eficiência',
  formula: 'Calculado',
};
const STANDARD: ItemKind[] = ['produced', 'target', 'projection', 'pace', 'efficiency'];
const block = (kind: ItemKind, colSpan = 3): CardItem => ({ id: kind, kind, colSpan, rowSpan: 2 });
export const DEFAULT_CARD: CardConfig = {
  version: 2,
  greenPct: 1,
  yellowPct: 0.95,
  items: [block('produced'), block('target'), block('projection'), block('pace'), block('efficiency', 12)],
};

type LegacyConfig = {
  visibleFields?: ItemKind[];
  greenPct?: number;
  yellowPct?: number;
  calculated?: Array<{ id: string; label: string; formula: string; unit: string; decimals: number }>;
  layout?: Array<{ id: string; order: number; colSpan: number; rowSpan: number }>;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Reads what is stored, including the first version (4-column grid, fields + formulas). */
export function normalizeCard(raw: unknown): CardConfig {
  const stored = (raw ?? {}) as Partial<CardConfig> & LegacyConfig;
  const greenPct = stored.greenPct ?? DEFAULT_CARD.greenPct;
  const yellowPct = stored.yellowPct ?? DEFAULT_CARD.yellowPct;
  if (stored.version === 2 && stored.items?.length) return { version: 2, greenPct, yellowPct, items: stored.items };
  if (!stored.visibleFields && !stored.calculated) return { ...DEFAULT_CARD, greenPct, yellowPct };
  const fields = stored.visibleFields ?? ['produced', 'target', 'projection', 'pace'];
  const ids = [...fields, ...(stored.calculated ?? []).map((item) => item.id), 'efficiency'];
  // The first version measured on 4 columns and 1-3 rows: three times wider, twice as tall.
  const layoutOf = (id: string) => stored.layout?.find((item) => item.id === id);
  const items: CardItem[] = ids.map((id) => {
    const layout = layoutOf(id);
    const formula = stored.calculated?.find((item) => item.id === id);
    return {
      id,
      kind: formula ? 'formula' : (id as ItemKind),
      ...(formula ? { label: formula.label, formula: formula.formula, unit: formula.unit, decimals: formula.decimals } : {}),
      colSpan: clamp((layout?.colSpan ?? 1) * 3, 1, COLUMNS),
      rowSpan: clamp((layout?.rowSpan ?? 1) * 2, 1, MAX_ROWS),
    };
  });
  const order = (id: string) => layoutOf(id)?.order ?? ids.indexOf(id);
  return { version: 2, greenPct, yellowPct, items: items.sort((a, b) => order(a.id) - order(b.id)) };
}

function number(value: number, decimals = 0) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: decimals }).format(value);
}
export function producedOf(machine: OperationMachine) {
  return machine.metric === 'blocks' ? machine.totals.pieces : machine.totals[machine.metric];
}

/** What a formula can read: the HMI's variables and the day's numbers the platform works out. */
export function formulaValues(machine: OperationMachine): Record<string, number> {
  const day = {
    'dia.produzido': producedOf(machine),
    'dia.meta': machine.target ?? 0,
    'dia.projecao': machine.projection,
    'dia.ritmo': machine.pacePerHour,
    'dia.eficiencia': (machine.utilization ?? 0) * 100,
    'dia.pecas': machine.totals.pieces,
    'dia.paletes': machine.totals.pallets,
    'dia.toneladas': machine.totals.tons,
  };
  // The names of the first version stay readable, so formulas written with them keep working.
  const legacy = {
    ProduzidoHoje: day['dia.produzido'],
    Meta: day['dia.meta'],
    Projecao: day['dia.projecao'],
    Ritmo: day['dia.ritmo'],
    Eficiencia: day['dia.eficiencia'],
  };
  return { ...machine.readings, ...legacy, ...day };
}
const DAY_HELP: Record<string, string> = {
  'dia.produzido': 'produzido hoje, na unidade da meta',
  'dia.meta': 'meta do dia (meta por turno × turnos de hoje)',
  'dia.projecao': 'projeção de fechamento do dia',
  'dia.ritmo': 'produção por hora hoje',
  'dia.eficiencia': 'tempo produzindo sobre o tempo em operação, em %',
  'dia.pecas': 'peças produzidas hoje',
  'dia.paletes': 'paletes produzidos hoje',
  'dia.toneladas': 'toneladas produzidas hoje',
};
export function variableOptions(machine: OperationMachine): VariableOption[] {
  const values = formulaValues(machine);
  return [
    ...Object.keys(DAY_HELP).map((name) => ({ name, description: DAY_HELP[name], value: number(values[name], 1) })),
    ...Object.entries(machine.readings).map(([name, value]) => ({
      name,
      description: 'variável da IHM',
      value: number(value, Math.abs(value) < 10 ? 2 : 0),
    })),
  ];
}

export type Health = 'offline' | 'green' | 'yellow' | 'red' | 'online';
/** The block's colour: grey without communication, else how the day's projection meets the target. */
export function healthOf(machine: OperationMachine, config: CardConfig): Health {
  if (machine.state === 'offline' || machine.state === 'unknown') return 'offline';
  if (!machine.target || machine.target <= 0) return 'online';
  const ratio = machine.projection / machine.target;
  return ratio >= config.greenPct ? 'green' : ratio >= config.yellowPct ? 'yellow' : 'red';
}
export const HEALTH_LABELS: Record<Health, string> = {
  offline: 'Sem comunicação',
  online: 'Online · sem meta',
  green: 'Dentro da meta',
  yellow: 'Perto de sair da meta',
  red: 'Fora da meta',
};

function itemValue(item: CardItem, machine: OperationMachine, values: Record<string, number>) {
  const unit = METRICS[machine.metric];
  switch (item.kind) {
    case 'produced':
      return `${number(producedOf(machine), machine.metric === 'tons' ? 1 : 0)} ${unit}`;
    case 'target':
      return machine.target ? `${number(machine.target)} ${unit}` : '—';
    case 'projection':
      return `${number(machine.projection)} ${unit}`;
    case 'pace':
      return `${number(machine.pacePerHour, 1)} ${unit}/h`;
    case 'efficiency':
      return machine.utilization == null ? '—' : `${number(machine.utilization * 100, 1)}%`;
    case 'formula': {
      const result = item.formula?.trim() ? evaluateFormula(item.formula, values) : null;
      return result == null ? '—' : `${number(result, item.decimals ?? 1)} ${item.unit ?? ''}`.trim();
    }
  }
}

type EditHandlers = {
  selected: string | null;
  select: (id: string | null) => void;
  move: (source: string, target: string) => void;
  shift: (id: string, by: -1 | 1) => void;
  resize: (id: string, colSpan: number, rowSpan: number) => void;
  remove: (id: string) => void;
};

/** The machine's row: name, communication and the grid of blocks, in the health colour. */
export function OperationCardBody({
  machine,
  config,
  edit,
  actions,
}: {
  machine: OperationMachine;
  config: CardConfig;
  edit?: EditHandlers;
  /** The row's buttons (edit, report, dashboard, location), under the name. */
  actions?: React.ReactNode;
}) {
  const values = formulaValues(machine);
  const health = healthOf(machine, config);
  const [dragging, setDragging] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; colSpan: number; rowSpan: number } | null>(null);
  const resizing = useRef(false);

  // Same gesture as the dashboard's resize corner: snaps to whole grid cells while dragging.
  function startResize(event: React.PointerEvent<HTMLSpanElement>, item: CardItem) {
    if (!edit) return;
    event.preventDefault();
    event.stopPropagation();
    const grid = event.currentTarget.closest('.machine-card-grid');
    if (!(grid instanceof HTMLElement)) return;
    const handle = event.currentTarget;
    const cell = handle.closest('.operation-block');
    cell?.setAttribute('draggable', 'false');
    handle.setPointerCapture(event.pointerId);
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap) || 6;
    const rowGap = parseFloat(styles.rowGap) || gap;
    const columnWidth = (grid.clientWidth - gap * (COLUMNS - 1)) / COLUMNS;
    const rowHeight = parseFloat(styles.gridAutoRows) || 28;
    const startX = event.clientX;
    const startY = event.clientY;
    let next = { id: item.id, colSpan: item.colSpan, rowSpan: item.rowSpan };
    resizing.current = true;
    edit.select(item.id);
    const move = (pointer: PointerEvent) => {
      next = {
        id: item.id,
        colSpan: clamp(item.colSpan + Math.round((pointer.clientX - startX) / (columnWidth + gap)), 1, COLUMNS),
        rowSpan: clamp(item.rowSpan + Math.round((pointer.clientY - startY) / (rowHeight + rowGap)), 1, MAX_ROWS),
      };
      setLive(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cell?.setAttribute('draggable', 'true');
      resizing.current = false;
      setLive(null);
      if (next.colSpan !== item.colSpan || next.rowSpan !== item.rowSpan) edit.resize(item.id, next.colSpan, next.rowSpan);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  return (
    <div className={`machine-row health-${health} ${edit ? 'editing' : ''}`}>
      <div className="machine-title">
        <span>CERÂMICA</span>
        <strong>{machine.deviceName}</strong>
        <span>
          {[machine.location.city, machine.location.state].filter(Boolean).join(' · ') ||
            machine.product ||
            'Localização não informada'}
        </span>
        <em className="machine-health">
          <i />
          {HEALTH_LABELS[health]}
        </em>
        {actions && <div className="machine-actions-row">{actions}</div>}
      </div>
      <div className="machine-card-grid">
        {config.items.map((item, index) => {
          const span = live?.id === item.id ? live : item;
          const isSelected = edit?.selected === item.id;
          return (
            <div
              key={item.id}
              className={`operation-block kind-${item.kind} ${isSelected ? 'selected' : ''} ${dragging && dragging !== item.id ? 'drop-zone' : ''}`}
              style={{ gridColumn: `span ${span.colSpan}`, gridRow: `span ${span.rowSpan}` }}
              draggable={Boolean(edit)}
              onClick={edit ? (event) => { event.stopPropagation(); edit.select(item.id); } : undefined}
              onDragStart={
                edit
                  ? (event) => {
                      if (resizing.current) return event.preventDefault();
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging(item.id);
                      edit.select(item.id);
                    }
                  : undefined
              }
              onDragOver={edit ? (event) => event.preventDefault() : undefined}
              onDrop={
                edit
                  ? (event) => {
                      event.preventDefault();
                      if (dragging) edit.move(dragging, item.id);
                      setDragging(null);
                    }
                  : undefined
              }
              onDragEnd={edit ? () => setDragging(null) : undefined}
            >
              <span className="operation-block-label">{item.label || KIND_LABELS[item.kind]}</span>
              <b>{itemValue(item, machine, values)}</b>
              {edit && (
                <>
                  <span className="operation-block-grip" aria-hidden="true">⠿</span>
                  {isSelected && (
                    <div className="operation-block-tools" onClick={(event) => event.stopPropagation()}>
                      <button type="button" title="Mover para trás" disabled={index === 0} onClick={() => edit.shift(item.id, -1)}>‹</button>
                      <button type="button" title="Mover para frente" disabled={index === config.items.length - 1} onClick={() => edit.shift(item.id, 1)}>›</button>
                      <i />
                      <button type="button" title="Diminuir largura" disabled={item.colSpan <= 1} onClick={() => edit.resize(item.id, item.colSpan - 1, item.rowSpan)}>−</button>
                      <span>{span.colSpan}×{span.rowSpan}</span>
                      <button type="button" title="Aumentar largura" disabled={item.colSpan >= COLUMNS} onClick={() => edit.resize(item.id, item.colSpan + 1, item.rowSpan)}>+</button>
                      <button type="button" title="Diminuir altura" disabled={item.rowSpan <= 1} onClick={() => edit.resize(item.id, item.colSpan, item.rowSpan - 1)}>▴</button>
                      <button type="button" title="Aumentar altura" disabled={item.rowSpan >= MAX_ROWS} onClick={() => edit.resize(item.id, item.colSpan, item.rowSpan + 1)}>▾</button>
                      <i />
                      <button type="button" className="danger" title="Remover bloco" disabled={config.items.length <= 1} onClick={() => edit.remove(item.id)}>×</button>
                    </div>
                  )}
                  <span className="operation-block-resize" title="Arraste para redimensionar" onPointerDown={(event) => startResize(event, item)} />
                  {live?.id === item.id && <span className="resize-badge">{live.colSpan} × {live.rowSpan}</span>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The editor: the plant's card as the list draws it, at the list's width, with its blocks
 * movable and resizable in place. Below it, the selected block's own settings.
 */
export function OperationCardEditor({
  machine,
  siteName,
  initial,
  width,
  onClose,
  onSaved,
}: {
  machine: OperationMachine;
  siteName: string;
  initial: CardConfig;
  /** Width of the card in the list, so the preview wraps exactly as it will there. */
  width: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CardConfig>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showingVariables, setShowingVariables] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const options = variableOptions(machine);
  const known = Object.keys(formulaValues(machine));
  const current = form.items.find((item) => item.id === selected) ?? null;
  const missing = STANDARD.filter((kind) => !form.items.some((item) => item.kind === kind));

  // Narrower modal than the list card (a phone): the preview takes the modal's width instead.
  useLayoutEffect(() => {
    if (!width || !frame.current) return;
    setFits(frame.current.clientWidth >= width);
  }, [width]);

  const setItems = (items: CardItem[]) => setForm((value) => ({ ...value, items }));
  const patch = (id: string, change: Partial<CardItem>) =>
    setItems(form.items.map((item) => (item.id === id ? { ...item, ...change } : item)));
  const handlers: EditHandlers = {
    selected,
    select: setSelected,
    move: (source, target) => {
      if (source === target) return;
      const moving = form.items.find((item) => item.id === source);
      if (!moving) return;
      const rest = form.items.filter((item) => item.id !== source);
      rest.splice(rest.findIndex((item) => item.id === target) + (form.items.findIndex((item) => item.id === source) < form.items.findIndex((item) => item.id === target) ? 1 : 0), 0, moving);
      setItems(rest);
    },
    shift: (id, by) => {
      const at = form.items.findIndex((item) => item.id === id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= form.items.length) return;
      const items = [...form.items];
      [items[at], items[to]] = [items[to], items[at]];
      setItems(items);
    },
    resize: (id, colSpan, rowSpan) => patch(id, { colSpan: clamp(colSpan, 1, COLUMNS), rowSpan: clamp(rowSpan, 1, MAX_ROWS) }),
    remove: (id) => {
      setItems(form.items.filter((item) => item.id !== id));
      setSelected(null);
    },
  };
  function add(kind: ItemKind) {
    const item: CardItem =
      kind === 'formula'
        ? { id: crypto.randomUUID(), kind, label: 'Calculado', formula: '', unit: '', decimals: 1, colSpan: 3, rowSpan: 2 }
        : block(kind);
    setItems([...form.items, item]);
    setSelected(item.id);
    setAdding(false);
  }
  async function save() {
    setSaving(true);
    setError('');
    try {
      if (form.yellowPct > form.greenPct) throw new Error('O limite amarelo deve ser menor que o verde.');
      for (const item of form.items.filter((entry) => entry.kind === 'formula')) {
        if (!item.formula?.trim()) throw new Error(`Escreva a fórmula de “${item.label || 'Calculado'}”.`);
        const problem = formulaError(item.formula, known);
        if (problem) throw new Error(`${item.label || 'Calculado'}: ${problem}`);
      }
      await mutate(`/devices/${machine.deviceId}/operation-card`, 'PATCH', form);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal-card operation-card-editor"
        style={width ? ({ '--card-width': `${width}px` } as React.CSSProperties) : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          <div>
            <div className="eyebrow">EDITAR CARTÃO</div>
            <h2>{machine.deviceName}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </div>
        <div className="operation-editor-bar">
          <small>Clique em um bloco para mover e redimensionar. Arraste pelo bloco para trocar de lugar, ou pelo canto para mudar o tamanho.</small>
          <div className="operation-add">
            <button type="button" className="primary" disabled={form.items.length >= MAX_ITEMS} onClick={() => setAdding(!adding)}>＋ Adicionar bloco</button>
            {adding && (
              <div className="operation-add-menu">
                {missing.map((kind) => (
                  <button type="button" key={kind} onClick={() => add(kind)}>{KIND_LABELS[kind]}</button>
                ))}
                <button type="button" onClick={() => add('formula')}>ƒ Fórmula</button>
              </div>
            )}
          </div>
        </div>
        <div className="operation-editor-stage" ref={frame} onClick={() => setSelected(null)}>
          <article className="plant-summary operation-editor-card" style={fits && width ? { width } : undefined}>
            <header>
              <div>
                <small>GRUPO / CLIENTE</small>
                <h2>{siteName}</h2>
              </div>
            </header>
            <div className="machine-grid">
              <OperationCardBody machine={machine} config={form} edit={handlers} />
            </div>
          </article>
        </div>
        {current && (
          <div className="operation-editor-section">
            <div className="operation-editor-title">
              <strong>{current.kind === 'formula' ? 'Fórmula do bloco' : KIND_LABELS[current.kind]}</strong>
              <small>{current.colSpan} de 12 colunas · {current.rowSpan} {current.rowSpan === 1 ? 'linha' : 'linhas'}</small>
            </div>
            <div className="operation-formula-row">
              <label>
                Título
                <input value={current.label ?? ''} maxLength={60} placeholder={KIND_LABELS[current.kind]} onChange={(event) => patch(current.id, { label: event.target.value })} />
              </label>
              {current.kind === 'formula' && (
                <>
                  <label className="operation-formula-main">
                    <span className="operation-formula-label">
                      Fórmula
                      <button type="button" className="operation-variables-link" onClick={() => setShowingVariables(true)}>Ver variáveis disponíveis</button>
                    </span>
                    <FormulaInput value={current.formula ?? ''} options={options} placeholder="dia.produzido / dia.meta * 100" onChange={(formula) => patch(current.id, { formula })} />
                  </label>
                  <label>
                    Unidade
                    <input value={current.unit ?? ''} maxLength={20} onChange={(event) => patch(current.id, { unit: event.target.value })} />
                  </label>
                  <label>
                    Casas
                    <select value={current.decimals ?? 1} onChange={(event) => patch(current.id, { decimals: Number(event.target.value) })}>
                      {[0, 1, 2, 3, 4].map((places) => <option key={places} value={places}>{places}</option>)}
                    </select>
                  </label>
                </>
              )}
            </div>
            {current.kind === 'formula' && current.formula?.trim() && (
              <small className={formulaError(current.formula, known) ? 'formula-error' : 'formula-preview'}>
                {formulaError(current.formula, known) ?? `Agora daria ${itemValue(current, machine, formulaValues(machine))}`}
              </small>
            )}
          </div>
        )}
        <div className="operation-editor-section">
          <div className="operation-editor-title">
            <strong>
              Cor do cartão
              <Hint align="left" text="Cinza sem comunicação. Com comunicação, a cor compara a projeção do dia com a meta: verde a partir do primeiro limite, amarelo a partir do segundo e vermelho abaixo dele. Sem meta cadastrada, fica verde enquanto houver comunicação." />
            </strong>
          </div>
          <div className="operation-health-row">
            <label>Verde a partir de (% da meta)<input type="number" min="0" max="200" value={Math.round(form.greenPct * 100)} onChange={(event) => setForm({ ...form, greenPct: Number(event.target.value) / 100 })} /></label>
            <label>Amarelo a partir de (% da meta)<input type="number" min="0" max="200" value={Math.round(form.yellowPct * 100)} onChange={(event) => setForm({ ...form, yellowPct: Number(event.target.value) / 100 })} /></label>
          </div>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button onClick={() => { setForm(DEFAULT_CARD); setSelected(null); }}>Restaurar padrão</button>
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving || !form.items.length} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar cartão'}</button>
        </div>
        {showingVariables && <VariablesModal options={options} onClose={() => setShowingVariables(false)} />}
      </section>
    </div>
  );
}
