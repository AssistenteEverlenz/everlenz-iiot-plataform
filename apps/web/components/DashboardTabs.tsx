'use client';

import { useState } from 'react';
import type { DashboardTab } from './data';
import { TAB_ICONS, TabIcon } from './tabIcons';

/**
 * The tabs of a panel, in the page header.
 *
 * A plant's panel grows until it is one column nobody scrolls to the end of. Who owns the
 * panel knows better than we do how to group it -- what belongs on the screen the shift
 * leader watches and what belongs on the one maintenance opens -- so the tabs are created,
 * named, given an icon and ordered in a window opened by the pencil at the end of the bar,
 * and a card is carried to one by dropping it on its name.
 *
 * A panel with no tabs draws nothing for whoever cannot edit it.
 */
export function DashboardTabs({
  tabs,
  active,
  onPick,
  editable,
  carrying,
  onManage,
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
  onManage: () => void;
  onDropWidget: (tabId: string) => void;
  counts: Record<string, number>;
}) {
  const [over, setOver] = useState<string | null>(null);
  if (!tabs.length && !editable) return null;

  return (
    <div className="dashboard-tabs" role="tablist" aria-label="Abas do painel">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`dashboard-tab${active === tab.id ? ' active' : ''}${
            over === tab.id ? ' over' : ''
          }`}
          // A card dropped on a tab moves to it.
          onDragOver={(event) => {
            if (!carrying) return;
            event.preventDefault();
            setOver(tab.id);
          }}
          onDragLeave={() => setOver((was) => (was === tab.id ? null : was))}
          onDrop={(event) => {
            event.preventDefault();
            setOver(null);
            if (carrying) onDropWidget(tab.id);
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-label={tab.name}
            title={tab.name}
            onClick={() => onPick(tab.id)}
          >
            <span className="dashboard-tab-icon">
              <TabIcon id={tab.icon} />
            </span>
            <span className="dashboard-tab-text">
              <b>{tab.name}</b>
              <small>
                {counts[tab.id]
                  ? `${counts[tab.id]} ${counts[tab.id] === 1 ? 'card' : 'cards'}`
                  : 'sem cards'}
              </small>
            </span>
          </button>
        </div>
      ))}
      {editable && (
        <button
          type="button"
          className="dashboard-tab-add"
          title={tabs.length ? 'Criar, editar ou excluir abas' : 'Dividir o painel em abas'}
          aria-label="Gerenciar abas"
          onClick={onManage}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />
          </svg>
          <span>{tabs.length ? 'Abas' : 'Criar abas'}</span>
        </button>
      )}
      {carrying && tabs.length > 0 && (
        <small className="dashboard-tab-hint">Solte o card sobre uma aba para movê-lo</small>
      )}
    </div>
  );
}

/**
 * Every tab of the panel in one window: add one, give it a name and an icon, change the order,
 * or delete it (which asks where its cards go, in its own window).
 */
export function TabsModal({
  tabs,
  counts,
  onClose,
  onCreate,
  onUpdate,
  onReorder,
  onRemove,
}: {
  tabs: DashboardTab[];
  counts: Record<string, number>;
  onClose: () => void;
  onCreate: (name: string, icon: string) => Promise<void>;
  onUpdate: (id: string, name: string, icon: string) => Promise<void>;
  onReorder: (id: string, position: number) => Promise<void>;
  onRemove: (id: string) => void;
}) {
  // null: the list; 'new': a tab being created; an id: that tab being edited.
  const [editing, setEditing] = useState<string | null>(tabs.length ? null : 'new');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(TAB_ICONS[0].id);
  const [saving, setSaving] = useState(false);

  const open = (tab: DashboardTab | null) => {
    setEditing(tab ? tab.id : 'new');
    setName(tab ? tab.name : '');
    setIcon(tab?.icon || TAB_ICONS[0].id);
  };
  const save = async () => {
    const clean = name.trim();
    if (!clean || !editing) return;
    setSaving(true);
    try {
      if (editing === 'new') await onCreate(clean, icon);
      else await onUpdate(editing, clean, icon);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card tabs-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">
          <div>
            <div className="eyebrow">ABAS DO PAINEL</div>
            <h2>
              {editing === 'new'
                ? 'Nova aba'
                : editing
                  ? 'Editar aba'
                  : 'Abas do painel'}
            </h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>

        {editing ? (
          <form
            className="tabs-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field full-field">
              Nome da aba
              <input
                autoFocus
                value={name}
                maxLength={40}
                placeholder="Ex.: Turno, Manutenção, Energia"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="field full-field">
              Ícone
              <div className="tabs-icon-grid" role="radiogroup" aria-label="Ícone da aba">
                {TAB_ICONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={icon === item.id}
                    className={icon === item.id ? 'active' : ''}
                    title={item.label}
                    onClick={() => setIcon(item.id)}
                  >
                    <TabIcon id={item.id} />
                    <small>{item.label}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => (tabs.length ? setEditing(null) : onClose())}
              >
                {tabs.length ? 'Voltar' : 'Cancelar'}
              </button>
              <button type="submit" className="primary-button" disabled={!name.trim() || saving}>
                {saving ? 'Salvando…' : editing === 'new' ? 'Criar aba' : 'Salvar'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <ul className="tabs-list">
              {tabs.map((tab, index) => (
                <li key={tab.id}>
                  <span className="dashboard-tab-icon">
                    <TabIcon id={tab.icon} />
                  </span>
                  <span className="tabs-list-name">
                    <b>{tab.name}</b>
                    <small>
                      {counts[tab.id]
                        ? `${counts[tab.id]} ${counts[tab.id] === 1 ? 'card' : 'cards'}`
                        : 'sem cards'}
                    </small>
                  </span>
                  <span className="tabs-list-tools">
                    <button
                      type="button"
                      title="Mover para cima"
                      aria-label={`Mover ${tab.name} para cima`}
                      disabled={index === 0}
                      onClick={() => void onReorder(tab.id, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Mover para baixo"
                      aria-label={`Mover ${tab.name} para baixo`}
                      disabled={index === tabs.length - 1}
                      onClick={() => void onReorder(tab.id, index + 1)}
                    >
                      ↓
                    </button>
                    <button type="button" onClick={() => open(tab)}>
                      Editar
                    </button>
                    <button type="button" className="danger" onClick={() => onRemove(tab.id)}>
                      Excluir
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Fechar
              </button>
              <button type="button" className="primary-button" onClick={() => open(null)}>
                + Nova aba
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
