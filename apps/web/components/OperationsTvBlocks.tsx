'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PlantMap } from './PlantMap';
import { healthOf, type CardConfig, type OperationMachine } from './OperationCard';

// Blocks of the operations TV that speak for the whole group, beside the plant cards: the fleet
// tiles, what every plant on screen made together, who is ahead, the mix of states, the map and
// the strip that names whoever stopped. They all read the plants of the screen being shown, so
// a screen with four ceramics totals those four.

export type FleetMachine = OperationMachine & {
  deviceId: string;
  siteName: string;
  updatedAt: string | null;
};

/** Names on the stopped strip before it starts counting the rest. */
const MAX_ALERTS = 6;

const STATE_COLORS: Record<string, string> = {
  producing: '#1fbf7a',
  idle: '#f2a93b',
  manual: '#e4572e',
  pause: '#cdb9ea',
  offline: '#98a6ab',
  unknown: '#98a6ab',
};
const STATE_LABELS: Record<string, string> = {
  producing: 'Produzindo',
  idle: 'Ociosa',
  manual: 'Manual / parada',
  pause: 'Pausa',
  offline: 'Sem comunicação',
  unknown: 'Sem dados',
};

function number(value: number, decimals = 0) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: decimals }).format(value);
}
const shortName = (name: string) => name.replace(/^cer[âa]mica\s+/i, '');

/** What the plants of a screen made together. Only comparable units are added up. */
export function fleetTotals(machines: FleetMachine[]) {
  const totals = { milheiros: 0, tons: 0, pallets: 0, pieces: 0 };
  let withTarget = 0;
  let onTarget = 0;
  for (const machine of machines) {
    const board = machine.board;
    if (board) {
      totals.milheiros += board.totals.milheiros;
      totals.tons += board.totals.tons;
      totals.pallets += board.totals.pallets;
      totals.pieces += board.totals.pieces;
    }
    if (board?.target && board.target.value > 0) {
      withTarget += 1;
      if (board.target.projected >= board.target.value) onTarget += 1;
    }
  }
  return { ...totals, withTarget, onTarget };
}

export function FleetKpis({ machines }: { machines: FleetMachine[] }) {
  const count = (state: string) => machines.filter((machine) => machine.state === state).length;
  const tiles: Array<[string, number, string | null]> = [
    ['Cerâmicas', machines.length, null],
    ['Produzindo', count('producing'), STATE_COLORS.producing],
    ['Ociosa', count('idle'), STATE_COLORS.idle],
    ['Manual / parada', count('manual'), STATE_COLORS.manual],
    ['Sem comunicação', count('offline'), STATE_COLORS.offline],
  ];
  return (
    <div className="tv-fleet tv-fleet-kpis">
      {tiles.map(([label, value, color]) => (
        <div key={label} style={color ? ({ '--dot': color } as React.CSSProperties) : undefined}>
          <b>{value}</b>
          <span>
            {color && <i />}
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FleetTotals({ machines }: { machines: FleetMachine[] }) {
  const totals = fleetTotals(machines);
  const tiles: Array<[string, string, string]> = [
    ['Produzido hoje', number(totals.milheiros, 1), 'milheiros'],
    ['Toneladas', number(totals.tons, 1), 't'],
    ['Paletes', number(totals.pallets), 'paletes'],
    [
      'Dentro da meta',
      totals.withTarget ? `${totals.onTarget}/${totals.withTarget}` : '—',
      totals.withTarget ? 'cerâmicas' : 'sem meta',
    ],
  ];
  return (
    <div className="tv-fleet tv-fleet-totals">
      <span className="tv-fleet-title">Total do grupo · hoje</span>
      <div>
        {tiles.map(([label, value, unit]) => (
          <div key={label}>
            <span>{label}</span>
            <b>
              {value}
              <small>{unit}</small>
            </b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FleetRanking({ machines }: { machines: FleetMachine[] }) {
  const rows = useMemo(
    () =>
      machines
        .map((machine) => ({
          name: shortName(machine.deviceName),
          value: machine.board?.totals.milheiros ?? 0,
          color: STATE_COLORS[machine.state] ?? STATE_COLORS.unknown,
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10),
    [machines],
  );
  return (
    <div className="tv-fleet tv-fleet-chart">
      <span className="tv-fleet-title">Produção por cerâmica · milheiros</span>
      <div className="tv-fleet-chart-body">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 46, bottom: 0, left: 4 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={112}
              tick={{ fontSize: 13, fill: 'currentColor' }}
              axisLine={false}
              tickLine={false}
            />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={false} label={{
                position: 'right',
                fill: 'currentColor',
                fontSize: 14,
                formatter: (value: unknown) => number(Number(value) || 0, 1),
              }}>
              {rows.map((row) => (
                <Cell key={row.name} fill={row.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function FleetStates({ machines }: { machines: FleetMachine[] }) {
  const slices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const machine of machines)
      counts.set(machine.state, (counts.get(machine.state) ?? 0) + 1);
    return [...counts.entries()]
      .map(([state, value]) => ({
        name: STATE_LABELS[state] ?? state,
        value,
        color: STATE_COLORS[state] ?? STATE_COLORS.unknown,
      }))
      .sort((a, b) => b.value - a.value);
  }, [machines]);
  return (
    <div className="tv-fleet tv-fleet-chart">
      <span className="tv-fleet-title">Situação da frota</span>
      <div className="tv-fleet-chart-body">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="52%"
              outerRadius="84%"
              paddingAngle={2}
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.name} fill={slice.color} stroke="none" />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="tv-fleet-legend">
        {slices.map((slice) => (
          <span key={slice.name}>
            <i style={{ background: slice.color }} />
            {slice.name} <b>{slice.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function FleetMap({ machines }: { machines: FleetMachine[] }) {
  const plants = useMemo(
    () =>
      machines.map((machine) => ({
        id: machine.deviceId,
        name: machine.deviceName,
        groupName: machine.siteName,
        state: machine.state,
        location: {
          ...machine.location,
          latitude: machine.location.latitude ?? null,
          longitude: machine.location.longitude ?? null,
        },
      })),
    [machines],
  );
  const located = plants.filter((plant) => plant.location.latitude != null).length;
  return (
    <div className="tv-fleet tv-fleet-map">
      <span className="tv-fleet-title">Mapa de operações</span>
      <div className="tv-fleet-map-frame">
        <PlantMap plants={plants} selected={null} onSelect={() => undefined} />
        {!located && <div className="tv-fleet-map-empty">Cadastre a localização das cerâmicas</div>}
      </div>
    </div>
  );
}

/** Whoever is not producing, named: what a wall display is for. */
export function FleetAlert({
  machines,
  configFor,
}: {
  machines: FleetMachine[];
  configFor: (machine: FleetMachine) => CardConfig;
}) {
  const stopped = machines.filter((machine) =>
    ['offline', 'manual', 'idle'].includes(machine.state),
  );
  const behind = machines.filter(
    (machine) => !stopped.includes(machine) && healthOf(machine, configFor(machine)) === 'red',
  );
  if (!stopped.length && !behind.length)
    return (
      <div className="tv-fleet tv-fleet-alert ok">
        <i style={{ background: STATE_COLORS.producing }} />
        Todas as cerâmicas produzindo
      </div>
    );
  // The strip is one line: what does not fit is counted, never cut in half.
  const named = [...stopped, ...behind].slice(0, MAX_ALERTS);
  const rest = stopped.length + behind.length - named.length;
  return (
    <div className="tv-fleet tv-fleet-alert">
      {named.filter((machine) => stopped.includes(machine)).map((machine) => (
        <span key={machine.deviceId}>
          <i style={{ background: STATE_COLORS[machine.state] ?? STATE_COLORS.unknown }} />
          {shortName(machine.deviceName)}
          <small>{STATE_LABELS[machine.state] ?? machine.state}</small>
        </span>
      ))}
      {named.filter((machine) => behind.includes(machine)).map((machine) => (
        <span key={machine.deviceId}>
          <i style={{ background: '#e4572e' }} />
          {shortName(machine.deviceName)}
          <small>fora da meta</small>
        </span>
      ))}
      {rest > 0 && <span className="tv-fleet-alert-rest">+{rest}</span>}
    </div>
  );
}
