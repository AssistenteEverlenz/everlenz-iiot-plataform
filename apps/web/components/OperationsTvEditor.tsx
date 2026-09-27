'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mutate, usePoll } from './data';
import { usePlatform } from './PlatformShell';
import {
  defaultScreens,
  freePlace,
  TV_COLUMNS,
  type OperationTvCard,
  type OperationTvScreen,
} from './operationsTvConfig';

// "Configurar TV da operação" (master only): the screens the group's wall display shows in turn
// and which plants sit on each. The preview is the real TV in an iframe; the editor draws a
// handle over each plant to move it (drag) or resize it (bottom-right corner) on the 12-column
// grid. Nothing changes on the customer's TV until "Salvar TV".

interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
  gapX: number;
  gapY: number;
}
interface Overview {
  sites: Array<{
    id: string;
    name: string;
    machines: Array<{ deviceId: string; deviceName: string }>;
  }>;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
/** The TV header shows the current screen name in a slot sized for this many letters. */
const SCREEN_NAME_MAX = 16;

export function OperationsTvEditor() {
  const { user } = usePlatform();
  const overview = usePoll<Overview>('/operations/overview', 300000);
  const saved = usePoll<{ screens: OperationTvScreen[] }>('/operations/tv', 600000);
  const plants = useMemo(
    () =>
      (overview.data?.sites ?? []).flatMap((site) =>
        site.machines.map((machine) => ({
          id: machine.deviceId,
          name: machine.deviceName,
          group: site.name,
        })),
      ),
    [overview.data],
  );
  const [screens, setScreens] = useState<OperationTvScreen[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [layout, setLayout] = useState<Layout | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (screens || !saved.data || !overview.data) return;
    setScreens(
      saved.data.screens.length
        ? saved.data.screens
        : defaultScreens(plants.map((plant) => plant.id)),
    );
  }, [saved.data, overview.data, plants, screens]);

  const screen = screens?.[current] ?? null;
  const send = useCallback(() => {
    if (!screens) return;
    frame.current?.contentWindow?.postMessage(
      { type: 'tv-config', screens, screen: current },
      window.location.origin,
    );
  }, [screens, current]);
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    send();
  }, [send]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'tv-ready') sendRef.current();
      if (event.data?.type === 'tv-layout') setLayout(event.data.layout as Layout);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const nameOf = (deviceId: string) =>
    plants.find((plant) => plant.id === deviceId)?.name ?? 'Cerâmica removida';

  function change(next: OperationTvScreen[]) {
    setScreens(next);
    setDirty(true);
    setMessage('');
  }
  function updateScreen(patch: Partial<OperationTvScreen>) {
    if (!screens || !screen) return;
    change(screens.map((item, index) => (index === current ? { ...item, ...patch } : item)));
  }
  function updateCard(index: number, patch: Partial<OperationTvCard>) {
    if (!screen) return;
    updateScreen({
      cards: screen.cards.map((card, position) =>
        position === index ? { ...card, ...patch } : card,
      ),
    });
  }

  // Grid pitch in preview pixels: one column (row) plus its gap.
  const rows = screen?.rows ?? 12;
  const pitchX = layout ? (layout.width + layout.gapX) / TV_COLUMNS : 0;
  const pitchY = layout ? (layout.height + layout.gapY) / rows : 0;
  function startDrag(event: React.PointerEvent, index: number, mode: 'move' | 'resize') {
    if (!screen || !layout) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(index);
    const card = screen.cards[index];
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = Math.round((moveEvent.clientX - startX) / pitchX);
      const dy = Math.round((moveEvent.clientY - startY) / pitchY);
      updateCard(
        index,
        mode === 'move'
          ? {
              x: clamp(card.x + dx, 1, TV_COLUMNS + 1 - card.w),
              y: clamp(card.y + dy, 1, rows + 1 - card.h),
            }
          : {
              w: clamp(card.w + dx, 1, TV_COLUMNS + 1 - card.x),
              h: clamp(card.h + dy, 1, rows + 1 - card.y),
            },
      );
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function addCard() {
    if (!screen || !adding) return;
    const place = freePlace(screen, 3, 6);
    updateScreen({ cards: [...screen.cards, { device_id: adding, ...place }] });
    setSelected(screen.cards.length);
    setAdding('');
  }
  function moveScreen(offset: number) {
    if (!screens) return;
    const target = current + offset;
    if (target < 0 || target >= screens.length) return;
    const next = [...screens];
    [next[current], next[target]] = [next[target], next[current]];
    change(next);
    setCurrent(target);
  }
  async function save() {
    if (!screens) return;
    setSaving(true);
    setError('');
    try {
      await mutate('/operations/tv', 'PUT', { screens });
      await saved.refresh();
      setDirty(false);
      setMessage('TV salva: o cliente já vê esta configuração.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar a TV.');
    } finally {
      setSaving(false);
    }
  }

  if (user.role !== 'master')
    return (
      <div className="notice">
        Somente o master configura a TV. Abra a TV da operação pelo botão na página de operação.
      </div>
    );

  const card = selected != null ? screen?.cards[selected] : undefined;
  /** Plants that no screen shows yet: what the operator most likely wants to add. */
  const placed = new Set((screens ?? []).flatMap((item) => item.cards.map((entry) => entry.device_id)));
  return (
    <div className="tv-editor">
      <div className="heading">
        <div>
          <div className="eyebrow">CONFIGURAR TV DA OPERAÇÃO</div>
          <h1>Gestão à vista · multicerâmicas</h1>
          <p>
            Monte as telas que a TV mostra em rodízio, cada uma com as cerâmicas que cabem sem
            rolagem. Arraste uma cerâmica para mover e o canto para redimensionar.
          </p>
        </div>
        <div className="toolbar-actions">
          <Link className="secondary-button" href="/operations">
            Voltar à operação
          </Link>
          <a className="secondary-button" href="/operations/tv" target="_blank" rel="noreferrer">
            Abrir TV
          </a>
          <button
            type="button"
            onClick={() => {
              change(defaultScreens(plants.map((plant) => plant.id)));
              setCurrent(0);
              setSelected(null);
            }}
          >
            Restaurar padrão
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving && <span className="button-spinner" />}
            {saving ? 'Salvando…' : dirty ? 'Salvar TV' : 'Salvo'}
          </button>
        </div>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="form-error">{error}</div>}

      {!screens ? (
        <div className="production-detail-loading">
          <span className="detail-spinner" aria-label="Carregando" />
        </div>
      ) : (
        <div className="tv-editor-body">
          {/* A div, not <aside>: the platform styles every <aside> as its fixed sidebar. */}
          <div className="tv-editor-side card">
            <div className="shift-section-title">Telas</div>
            <ul className="tv-editor-screens">
              {screens.map((item, index) => (
                <li key={index}>
                  <button
                    type="button"
                    className={index === current ? 'active' : ''}
                    onClick={() => {
                      setCurrent(index);
                      setSelected(null);
                    }}
                  >
                    {index + 1}. {item.name}{' '}
                    <small>
                      {item.duration_seconds}s · {item.cards.length} cerâmicas
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={screens.length >= 12}
              onClick={() => {
                change([
                  ...screens,
                  { name: `Tela ${screens.length + 1}`, duration_seconds: 20, rows: 12, cards: [] },
                ]);
                setCurrent(screens.length);
                setSelected(null);
              }}
            >
              + Nova tela
            </button>

            {screen && (
              <div className="tv-editor-group">
                <div className="shift-section-title">Tela selecionada</div>
                <label className="field">
                  Nome (até {SCREEN_NAME_MAX} caracteres)
                  <input
                    value={screen.name}
                    maxLength={SCREEN_NAME_MAX}
                    onChange={(event) =>
                      updateScreen({ name: event.target.value.slice(0, SCREEN_NAME_MAX) })
                    }
                  />
                </label>
                <div className="tv-editor-row">
                  <label className="field">
                    Tempo (s)
                    <input
                      type="number"
                      min={5}
                      max={600}
                      value={screen.duration_seconds}
                      onChange={(event) =>
                        updateScreen({
                          duration_seconds: clamp(Number(event.target.value) || 20, 5, 600),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    Linhas
                    <input
                      type="number"
                      min={4}
                      max={24}
                      value={screen.rows}
                      onChange={(event) =>
                        updateScreen({ rows: clamp(Number(event.target.value) || 12, 4, 24) })
                      }
                    />
                  </label>
                </div>
                <div className="tv-editor-row">
                  <button type="button" disabled={current === 0} onClick={() => moveScreen(-1)}>
                    ↑ Subir
                  </button>
                  <button
                    type="button"
                    disabled={current === screens.length - 1}
                    onClick={() => moveScreen(1)}
                  >
                    ↓ Descer
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={screens.length <= 1}
                    onClick={() => {
                      change(screens.filter((_, index) => index !== current));
                      setCurrent(Math.max(0, current - 1));
                      setSelected(null);
                    }}
                  >
                    Excluir tela
                  </button>
                </div>
              </div>
            )}

            {screen && (
              <div className="tv-editor-group">
                <div className="shift-section-title">Adicionar cerâmica</div>
                <select value={adding} onChange={(event) => setAdding(event.target.value)}>
                  <option value="">Escolha…</option>
                  <optgroup label="Ainda fora da TV">
                    {plants
                      .filter((plant) => !placed.has(plant.id))
                      .map((plant) => (
                        <option key={plant.id} value={plant.id}>
                          {plant.name} · {plant.group}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Já em alguma tela">
                    {plants
                      .filter((plant) => placed.has(plant.id))
                      .map((plant) => (
                        <option key={plant.id} value={plant.id}>
                          {plant.name} · {plant.group}
                        </option>
                      ))}
                  </optgroup>
                </select>
                <button type="button" disabled={!adding} onClick={addCard}>
                  Adicionar
                </button>
              </div>
            )}

            {screen && card && selected != null && (
              <div className="tv-editor-group">
                <div className="shift-section-title">Cerâmica: {nameOf(card.device_id)}</div>
                <div className="tv-editor-grid4">
                  {(
                    [
                      ['x', 'Coluna', 1, TV_COLUMNS + 1 - card.w],
                      ['y', 'Linha', 1, rows + 1 - card.h],
                      ['w', 'Largura', 1, TV_COLUMNS + 1 - card.x],
                      ['h', 'Altura', 1, rows + 1 - card.y],
                    ] as const
                  ).map(([key, label, min, max]) => (
                    <label className="field" key={key}>
                      {label}
                      <input
                        type="number"
                        min={min}
                        max={max}
                        value={card[key]}
                        onChange={(event) =>
                          updateCard(selected, {
                            [key]: clamp(Number(event.target.value) || min, min, max),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="danger-text"
                  onClick={() => {
                    updateScreen({ cards: screen.cards.filter((_, index) => index !== selected) });
                    setSelected(null);
                  }}
                >
                  Remover da tela
                </button>
              </div>
            )}
          </div>

          <div className="tv-editor-stage">
            <div className="tv-editor-canvas">
              <iframe
                ref={frame}
                src="/operations/tv?preview=1"
                title="Prévia da TV"
                onLoad={() => send()}
              />
              {layout && screen && (
                <div className="tv-editor-overlay" onPointerDown={() => setSelected(null)}>
                  {screen.cards.map((item, index) => (
                    <div
                      key={index}
                      className={`tv-editor-handle ${selected === index ? 'selected' : ''}`}
                      style={{
                        left: layout.x + (item.x - 1) * pitchX,
                        top: layout.y + (item.y - 1) * pitchY,
                        width: item.w * pitchX - layout.gapX,
                        height: item.h * pitchY - layout.gapY,
                      }}
                      onPointerDown={(event) => startDrag(event, index, 'move')}
                    >
                      <span>{nameOf(item.device_id)}</span>
                      <i onPointerDown={(event) => startDrag(event, index, 'resize')} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <small className="tv-editor-hint">
              Prévia real da TV (tela {current + 1} de {screens.length}). As cerâmicas podem se
              sobrepor: ajuste posição e tamanho até ficar como quer. As alterações só chegam ao
              cliente ao salvar.
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
