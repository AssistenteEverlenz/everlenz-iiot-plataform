/**
 * The icons a panel tab can wear (migration 044).
 *
 * On a phone the closed tabs show only their icon, so the list leans on what the platform is
 * about -- production, the line, energy, stops, stock -- and then the common ones. Each is a
 * 24x24 stroke drawing, two pixels wide, so they all sit on the bar with the same weight.
 */
export const TAB_ICONS: Array<{ id: string; label: string; d: string }> = [
  // The platform
  { id: 'grid', label: 'Painel', d: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
  { id: 'factory', label: 'Fábrica', d: 'M3 21V10l6 4V10l6 4V5h6v16zM7 17h2M12 17h2M17 17h2' },
  { id: 'clock', label: 'Turno', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2' },
  { id: 'gauge', label: 'Ritmo', d: 'M4.5 18a9 9 0 1 1 15 0M12 13l4-4M12 13h0' },
  { id: 'target', label: 'Meta', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 11.5v1' },
  { id: 'pause', label: 'Paradas', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 9v6M14 9v6' },
  { id: 'wrench', label: 'Manutenção', d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z' },
  { id: 'bell', label: 'Alarmes', d: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4' },
  { id: 'bolt', label: 'Energia', d: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  { id: 'flame', label: 'Forno', d: 'M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2.5-5 .5 2 1.5 2.5 2.5 2.5 0-2.5-1-4.5 0-7.5z' },
  { id: 'thermometer', label: 'Temperatura', d: 'M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0zM12 9v7' },
  { id: 'droplet', label: 'Água / umidade', d: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z' },
  { id: 'wind', label: 'Pressão / ar', d: 'M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8' },
  { id: 'bag', label: 'Ensaque', d: 'M7 7V6a5 5 0 0 1 10 0v1M5 7h14l-1 14H6zM9 12h6' },
  { id: 'mixer', label: 'Mistura', d: 'M5 4h14l-2 9H7zM7 13l-1 7h12l-1-7M12 4v9M9 8h6' },
  { id: 'layers', label: 'Paletes', d: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5' },
  { id: 'box', label: 'Estoque', d: 'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8' },
  { id: 'truck', label: 'Expedição', d: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' },
  { id: 'mountain', label: 'Matéria-prima', d: 'M3 20l6-10 4 6 2-3 6 7z' },
  { id: 'cpu', label: 'Equipamento', d: 'M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4' },
  { id: 'wifi', label: 'Comunicação', d: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h0' },
  { id: 'check', label: 'Qualidade', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6' },
  { id: 'money', label: 'Custos', d: 'M12 3v18M16.5 7.5c-.8-1.2-2.5-2-4.5-2-2.5 0-4.5 1.3-4.5 3.2 0 4.3 9 2.3 9 6.6 0 1.9-2 3.2-4.5 3.2-2 0-3.7-.8-4.5-2' },
  // The common ones
  { id: 'bars', label: 'Barras', d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { id: 'trend', label: 'Tendência', d: 'M3 17l6-6 4 4 8-8M15 7h6v6' },
  { id: 'pie', label: 'Participação', d: 'M12 3a9 9 0 1 0 9 9h-9zM15 2.5A9 9 0 0 1 21.5 9H15z' },
  { id: 'calendar', label: 'Calendário', d: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M8 13h2M14 13h2M8 16h2' },
  { id: 'file', label: 'Relatório', d: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6' },
  { id: 'list', label: 'Lista', d: 'M8 6h13M8 12h13M8 18h13M3.5 6h0M3.5 12h0M3.5 18h0' },
  { id: 'users', label: 'Equipe', d: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14.5a7 7 0 0 1 4 6.5' },
  { id: 'alert', label: 'Atenção', d: 'M12 3l10 18H2zM12 10v5M12 18h0' },
  { id: 'star', label: 'Favoritos', d: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9z' },
  { id: 'home', label: 'Início', d: 'M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6' },
  { id: 'settings', label: 'Ajustes', d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1' },
  { id: 'eye', label: 'Acompanhamento', d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
  { id: 'tv', label: 'TV / tela', d: 'M3 5h18v12H3zM8 21h8M12 17v4' },
];

const BY_ID = new Map(TAB_ICONS.map((icon) => [icon.id, icon]));

/** A tab's icon; an unknown or empty one draws the panel grid. */
export function TabIcon({ id }: { id?: string | null }) {
  const icon = BY_ID.get(id ?? '') ?? TAB_ICONS[0];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icon.d} />
    </svg>
  );
}
