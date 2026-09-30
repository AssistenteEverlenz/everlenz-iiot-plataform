'use client';

import { useEffect, useRef, useState } from 'react';
import type { DashboardTab } from './data';

/**
 * The tabs of a panel, in the page header.
 *
 * A plant's panel grows until it is one column nobody scrolls to the end of. Who owns the
 * panel knows better than we do how to group it -- what belongs on the screen the shift
 * leader watches and what belongs on the one maintenance opens -- so the tabs are created,
 * named and ordered here, and a card is carried to one by dropping it on its name.
 *
 * A panel with no tabs draws nothing: the strip only appears once there is a first one.
 */
export function DashboardTabs({
  tabs,
  active,
  onPick,
  editable,
  carrying,
  onCreate,
  onRename,
  onReorder,
  onRemove,
  onDropWidget,
  counts,
}: {
  tabs: DashboardTab[];
  /** The open tab, or '' while the panel has none. */
  active: string;
  onPick: (id: string) => void;
  /** Only a master creates, renames and orders them. */
  editable: boolean;
  /** A card is being dragged: the tabs light up as places to drop it. */
  carrying: boolean;
  onCreate: (name: string) => Promise<void> | void;
  onRename: (id: string, name: string) => Promise<void> | void;
  onReorder: (id: string, position: number) => Promise<void> | void;
  onRemove: (id: string) => void;
  onDropWidget: (tabId: string) => void;
  counts: Record<string, number>;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) field.current?.focus();
  }, [renaming]);

  if (!tabs.length && !editable) return null;

  const start = (tab: DashboardTab) => {
    setRenaming(tab.id);
    setDraft(tab.name);
  };
  const finish = async () => {
    const id = renaming;
    setRenaming(null);
    if (!id) return;
    const name = draft.trim();
    const was = tabs.find((tab) => tab.id === id);
    if (name && was && name !== was.name) await onRename(id, name);
  };

  return (
    <div className="dashboard-tabs" role="tablist" aria-label="Abas do painel">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={`dashboard-tab${active === tab.id ? ' active' : ''}${
            over === tab.id ? ' over' : ''
          }${dragging === tab.id ? ' dragging' : ''}`}
          // A card dropped on a tab moves to it; a tab dropped on a tab changes the order.
          onDragOver={(event) => {
            if (!carrying && !dragging) return;
            event.preventDefault();
            setOver(tab.id);
          }}
          onDragLeave={() => setOver((was) => (was === tab.id ? null : was))}
          onDrop={(event) => {
            event.preventDefault();
            setOver(null);
            if (carrying) onDropWidget(tab.id);
            else if (dragging && dragging !== tab.id) {
              void onReorder(dragging, index);
              setDragging(null);
            }
          }}
        >
          {renaming === tab.id ? (
            <input
              ref={field}
              className="dashboard-tab-rename"
              value={draft}
              maxLength={40}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void finish()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void finish();
                if (event.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              draggable={editable}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDragging(tab.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onClick={() => onPick(tab.id)}
              onDoubleClick={() => editable && start(tab)}
              title={editable ? 'Clique duas vezes para renomear' : undefined}
            >
              {tab.name}
              {counts[tab.id] ? <em>{counts[tab.id]}</em> : null}
            </button>
          )}
          {editable && renaming !== tab.id && active === tab.id && (
            <span className="dashboard-tab-tools">
              <button type="button" title="Renomear aba" aria-label="Renomear aba" onClick={() => start(tab)}>
                ✎
              </button>
              <button type="button" title="Excluir aba" aria-label="Excluir aba" onClick={() => onRemove(tab.id)}>
                ×
              </button>
            </span>
          )}
        </div>
      ))}
      {editable && (
        <button
          type="button"
          className="dashboard-tab-add"
          title="Nova aba"
          onClick={() => void onCreate(`Aba ${tabs.length + 1}`)}
        >
          + Aba
        </button>
      )}
      {carrying && tabs.length > 0 && (
        <small className="dashboard-tab-hint">Solte o card sobre uma aba para movê-lo</small>
      )}
    </div>
  );
}
