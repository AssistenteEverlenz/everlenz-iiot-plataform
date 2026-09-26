'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormulaInput } from './FormulaInput';
import { canonicalVariable, evaluateFormula, formulaError, modernizeFormula } from './formula';
import { Hint } from './Hint';
import { VariablesModal } from './VariablesModal';
import { mutate } from './data';
import {
  hmiVariables,
  knownVariables,
  PANEL_VARIABLES,
  panelVariables,
  variableOptionsFor,
  type PanelSource,
} from './variables';

// The plant's block on the operations page. The same component draws it in the list and inside
// the editor, so what is arranged in the editor is exactly what the list shows. Like a dashboard
// card it is an ordered list of blocks on a 12-column grid, and every block is a formula: one
// variable (ihm.* or painel.*, the same names as on the dashboard) or the plant's own arithmetic.

type Metric = 'milheiros' | 'tons' | 'blocks' | 'pallets';
export type OperationMachine = {
  deviceId: string;
  deviceName: string;
  state: string;
  product: string | null;
  metric: Metric;
  location: { city: string | null; state: string | null };
  readings: Record<string, number>;
  /** The production board of the running (or last) shift, as the dashboard shows it. */
  board: PanelSource | null;
};
export type CardItem = {
  id: string;
  label: string;
  formula: string;
  unit: string;
  decimals: number;
  colSpan: number;
  rowSpan: number;
};
export type CardConfig = { version: 3; greenPct: number; yellowPct: number; items: CardItem[] };

const COLUMNS = 12;
const MAX_ROWS = 6;
export const MAX_ITEMS = 16;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A block reading one variable, titled and with the unit the variable is counted in. */
function blockFor(name: string, metric: Metric, colSpan = 3): CardItem {
  const panel = PANEL_VARIABLES[name];
  return {
    id: crypto.randomUUID(),
    label: panel?.label ?? name.replace(/^ihm\./, ''),
    formula: name,
    unit: panel?.unit(metric) ?? '',
    decimals: panel?.decimals ?? 1,
    colSpan,
    rowSpan: 2,
  };
}
export function defaultCard(metric: Metric): CardConfig {
  return {
    version: 3,
    greenPct: 1,
    yellowPct: 0.95,
    items: [
      { ...blockFor('painel.produzido', metric), id: 'produced' },
      { ...blockFor('painel.meta', metric), id: 'target' },
      { ...blockFor('painel.projecao', metric), id: 'projection' },
      { ...blockFor('painel.ritmo', metric), id: 'pace' },
      { ...blockFor('painel.aproveitamento', metric, 12), id: 'efficiency' },
    ],
  };
}

// What the first two versions stored, read into blocks: fixed numbers become their variable.
const LEGACY_KINDS: Record<string, string> = {
  produced: 'painel.produzido',
  target: 'painel.meta',
  projection: 'painel.projecao',
  pace: 'painel.ritmo',
  efficiency: 'painel.aproveitamento',
};
type StoredItem = Partial<CardItem> & { kind?: string };
type Stored = {
  version?: number;
  greenPct?: number;
  yellowPct?: number;
  items?: StoredItem[];
  visibleFields?: string[];
  calculated?: Array<{ id: string; label: string; formula: string; unit: string; decimals: number }>;
  layout?: Array<{ id: string; order: number; colSpan: number; rowSpan: number }>;
};
export function normalizeCard(raw: unknown, metric: Metric): CardConfig {
  const stored = (raw ?? {}) as Stored;
  const base = defaultCard(metric);
  const greenPct = stored.greenPct ?? base.greenPct;
  const yellowPct = stored.yellowPct ?? base.yellowPct;
  const fromKind = (id: string, kind: string, extra: StoredItem): CardItem => {
    const variable = LEGACY_KINDS[kind];
    const block = variable ? blockFor(variable, metric) : blockFor('', metric);
    return {
      ...block,
      id,
      label: extra.label || (variable ? block.label : 'Calculado'),
      formula: modernizeFormula(variable ?? extra.formula ?? ''),
      unit: variable ? (extra.unit ?? block.unit) : (extra.unit ?? ''),
      decimals: extra.decimals ?? block.decimals,
      colSpan: clamp(extra.colSpan ?? 3, 1, COLUMNS),
      rowSpan: clamp(extra.rowSpan ?? 2, 1, MAX_ROWS),
    };
  };
  if (stored.version === 3 && stored.items?.length)
    return {
      version: 3,
      greenPct,
      yellowPct,
      items: stored.items.map((item) => ({ ...(item as CardItem), formula: modernizeFormula(item.formula ?? '') })),
    };
  if (stored.version === 2 && stored.items?.length)
    return {
      version: 3,
      greenPct,
      yellowPct,
      items: stored.items.map((item) => fromKind(item.id ?? crypto.randomUUID(), item.kind ?? 'formula', item)),
    };
  if (!stored.visibleFields && !stored.calculated) return { ...base, greenPct, yellowPct };
  // The first version: fixed fields plus formulas on a 4-column grid of 1-3 rows.
  const ids = [...(stored.visibleFields ?? []), ...(stored.calculated ?? []).map((item) => item.id), 'efficiency'];
  const layoutOf = (id: string) => stored.layout?.find((item) => item.id === id);
  const items = ids.map((id) => {
    const layout = layoutOf(id);
    const formula = stored.calculated?.find((item) => item.id === id);
    return fromKind(id, formula ? 'formula' : id, {
      ...(formula ?? {}),
      colSpan: (layout?.colSpan ?? 1) * 3,
      rowSpan: (layout?.rowSpan ?? 1) * 2,
    });
  });
  const order = (id: string) => layoutOf(id)?.order ?? ids.indexOf(id);
  return { version: 3, greenPct, yellowPct, items: items.sort((a, b) => order(a.id) - order(b.id)) };
}

function number(value: number, decimals = 0) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: decimals }).format(value);
}

/** What a block reads: the HMI's latest readings and the production board's numbers. */
export function formulaValues(machine: OperationMachine): Record<string, number> {
  return { ...hmiVariables(machine.readings), ...panelVariables(machine.board) };
}

export type Health = 'offline' | 'green' | 'yellow' | 'red' | 'online';
/** Grey without communication, else how the shift's projection meets its target. */
export function healthOf(machine: OperationMachine, config: CardConfig): Health {
  if (machine.state === 'offline' || machine.state === 'unknown') return 'offline';
  const target = machine.board?.target;
  if (!target || target.value <= 0) return 'online';
  const ratio = target.projected / target.value;
  return ratio >= config.greenPct ? 'green' : ratio >= config.yellowPct ? 'yellow' : 'red';
}
export const HEALTH_LABELS: Record<Health, string> = {
  offline: 'Sem comunicação',
  online: 'Online · sem meta',
  green: 'Dentro da meta',
  yellow: 'Perto de sair da meta',
  red: 'Fora da meta',
};

function itemValue(item: CardItem, values: Record<string, number>) {
  const result = item.formula.trim() ? evaluateFormula(item.formula, values) : null;
  return result == null ? '—' : `${number(result, item.decimals)} ${item.unit}`.trim();
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
          const single = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(item.formula.trim());
          return (
            <div
              key={item.id}
              className={`operation-block ${single ? '' : 'kind-formula'} ${isSelected ? 'selected' : ''} ${dragging && dragging !== item.id ? 'drop-zone' : ''}`}
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
              <span className="operation-block-label">{item.label || 'Calculado'}</span>
              <b>{itemValue(item, values)}</b>
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
 * movable and resizable in place. Below it, the selected block: its title and what it reads,
 * either one variable picked from the list or a formula.
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
  const [freeFormula, setFreeFormula] = useState<Set<string>>(new Set());
  const [showingVariables, setShowingVariables] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const values = useMemo(() => formulaValues(machine), [machine]);
  const options = useMemo(() => variableOptionsFor(values), [values]);
  const known = knownVariables(values);
  const current = form.items.find((item) => item.id === selected) ?? null;
  const currentIsVariable =
    current != null &&
    !freeFormula.has(current.id) &&
    options.some((option) => option.name === canonicalVariable(current.formula.trim()));

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
      const from = form.items.findIndex((item) => item.id === source);
      const to = form.items.findIndex((item) => item.id === target);
      if (from < 0 || to < 0) return;
      const items = [...form.items];
      const [moving] = items.splice(from, 1);
      items.splice(to, 0, moving);
      setItems(items);
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
  function add(name: string | null) {
    const item = name
      ? blockFor(name, machine.metric)
      : { ...blockFor('', machine.metric), label: 'Calculado', decimals: 1 };
    if (!name) setFreeFormula((set) => new Set(set).add(item.id));
    setItems([...form.items, item]);
    setSelected(item.id);
    setAdding(false);
  }
  /** Picking a variable for the block: its title and unit follow unless they were written. */
  function pick(name: string) {
    if (!current) return;
    const previous = PANEL_VARIABLES[current.formula]?.label ?? current.formula.replace(/^ihm\./, '');
    const next = blockFor(name, machine.metric);
    patch(current.id, {
      formula: name,
      label: !current.label || current.label === previous ? next.label : current.label,
      unit: next.unit || current.unit,
      decimals: next.decimals,
    });
  }
  async function save() {
    setSaving(true);
    setError('');
    try {
      if (form.yellowPct > form.greenPct) throw new Error('O limite amarelo deve ser menor que o verde.');
      for (const item of form.items) {
        if (!item.formula.trim()) throw new Error(`Escolha a variável ou escreva a fórmula de “${item.label || 'Calculado'}”.`);
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
  const panelOptions = options.filter((option) => option.name.startsWith('painel.'));
  const hmiOptions = options.filter((option) => option.name.startsWith('ihm.'));

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
          <small>Clique em um bloco para configurar, mover e redimensionar. Arraste pelo bloco para trocar de lugar, ou pelo canto para mudar o tamanho.</small>
          <div className="operation-add">
            <button type="button" className="primary" disabled={form.items.length >= MAX_ITEMS} onClick={() => setAdding(!adding)}>＋ Adicionar bloco</button>
            {adding && (
              <div className="operation-add-menu">
                <button type="button" className="operation-add-formula" onClick={() => add(null)}>ƒ Fórmula livre</button>
                {panelOptions.length > 0 && <strong>Quadro de produção</strong>}
                {panelOptions.map((option) => (
                  <button type="button" key={option.name} onClick={() => add(option.name)}>
                    <span>{PANEL_VARIABLES[option.name]?.label ?? option.name}</span>
                    <small>{option.value}</small>
                  </button>
                ))}
                {hmiOptions.length > 0 && <strong>IHM</strong>}
                {hmiOptions.map((option) => (
                  <button type="button" key={option.name} onClick={() => add(option.name)}>
                    <span>{option.name.replace(/^ihm\./, '')}</span>
                    <small>{option.value}</small>
                  </button>
                ))}
                {!options.length && <small className="operation-add-empty">Sem variáveis lidas ainda: use uma fórmula livre.</small>}
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
              <strong>{current.label || 'Bloco'}</strong>
              <small>{current.colSpan} de 12 colunas · {current.rowSpan} {current.rowSpan === 1 ? 'linha' : 'linhas'}</small>
            </div>
            <div className="operation-source-toggle" role="radiogroup" aria-label="O que o bloco mostra">
              <button type="button" className={currentIsVariable ? 'active' : ''} onClick={() => {
                setFreeFormula((set) => { const next = new Set(set); next.delete(current.id); return next; });
                if (!options.some((option) => option.name === canonicalVariable(current.formula.trim())) && options[0]) pick(options[0].name);
              }}>Variável</button>
              <button type="button" className={currentIsVariable ? '' : 'active'} onClick={() => setFreeFormula((set) => new Set(set).add(current.id))}>Fórmula</button>
            </div>
            <div className="operation-formula-row">
              <label>
                Título
                <input value={current.label} maxLength={60} onChange={(event) => patch(current.id, { label: event.target.value })} />
              </label>
              <label className="operation-formula-main">
                <span className="operation-formula-label">
                  {currentIsVariable ? 'Variável' : 'Fórmula'}
                  <button type="button" className="operation-variables-link" onClick={() => setShowingVariables(true)}>Ver variáveis disponíveis</button>
                </span>
                {currentIsVariable ? (
                  <select value={canonicalVariable(current.formula.trim())} onChange={(event) => pick(event.target.value)}>
                    <optgroup label="Quadro de produção (painel.*)">
                      {panelOptions.map((option) => (
                        <option key={option.name} value={option.name}>{option.name} — {option.value}</option>
                      ))}
                    </optgroup>
                    <optgroup label="IHM (ihm.*)">
                      {hmiOptions.map((option) => (
                        <option key={option.name} value={option.name}>{option.name} — {option.value}</option>
                      ))}
                    </optgroup>
                  </select>
                ) : (
                  <FormulaInput value={current.formula} options={options} placeholder="painel.pecas / painel.horas_produzindo" onChange={(formula) => patch(current.id, { formula })} />
                )}
              </label>
              <label>
                Unidade
                <input value={current.unit} maxLength={20} onChange={(event) => patch(current.id, { unit: event.target.value })} />
              </label>
              <label>
                Casas
                <select value={current.decimals} onChange={(event) => patch(current.id, { decimals: Number(event.target.value) })}>
                  {[0, 1, 2, 3, 4].map((places) => <option key={places} value={places}>{places}</option>)}
                </select>
              </label>
            </div>
            {current.formula.trim() && (
              <small className={formulaError(current.formula, known) ? 'formula-error' : 'formula-preview'}>
                {formulaError(current.formula, known) ??
                  (currentIsVariable
                    ? `${options.find((option) => option.name === canonicalVariable(current.formula.trim()))?.description ?? ''} · agora ${itemValue(current, values)}`
                    : `Agora daria ${itemValue(current, values)}`)}
              </small>
            )}
          </div>
        )}
        <div className="operation-editor-section">
          <div className="operation-editor-title">
            <strong>
              Cor do cartão
              <Hint align="left" text="Cinza sem comunicação. Com comunicação, a cor compara a projeção do turno com a meta do turno (as mesmas do quadro de produção): verde a partir do primeiro limite, amarelo a partir do segundo e vermelho abaixo dele. Sem meta cadastrada, fica verde enquanto houver comunicação." />
            </strong>
          </div>
          <div className="operation-health-row">
            <label>Verde a partir de (% da meta)<input type="number" min="0" max="200" value={Math.round(form.greenPct * 100)} onChange={(event) => setForm({ ...form, greenPct: Number(event.target.value) / 100 })} /></label>
            <label>Amarelo a partir de (% da meta)<input type="number" min="0" max="200" value={Math.round(form.yellowPct * 100)} onChange={(event) => setForm({ ...form, yellowPct: Number(event.target.value) / 100 })} /></label>
          </div>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button onClick={() => { setForm(defaultCard(machine.metric)); setSelected(null); }}>Restaurar padrão</button>
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving || !form.items.length} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar cartão'}</button>
        </div>
        {showingVariables && <VariablesModal options={options} onClose={() => setShowingVariables(false)} />}
      </section>
    </div>
  );
}

