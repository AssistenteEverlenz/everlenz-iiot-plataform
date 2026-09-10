'use client';
import { useCallback, useEffect, useState } from 'react';
export interface Device {
  id: string;
  device_code: string;
  site_id: string;
  slug: string;
  name: string;
  manufacturer: string;
  model: string;
  online: boolean;
  last_message_at: string | null;
  adapter_type: string;
  serial_number?: string | null;
  mqtt_identifier?: string | null;
  provisioning_status?: string;
  site_name?: string;
  site_reference?: string;
  mqtt_topic?: string;
  mqtt_username?: string;
  /** The broker password is never stored or returned: it exists only in the response of
   *  device creation and of POST /devices/:id/mqtt-credential. */
  mqtt_credential_rotated_at?: string | null;
}
export interface Sample {
  tag_id: string;
  key: string;
  unit: string | null;
  data_type: string;
  timestamp: string | null;
  value_number: number | null;
  value_text: string | null;
  value_boolean: boolean | null;
  quality: string | null;
}
export interface Raw {
  id: string;
  topic: string;
  received_at: string;
  processed_at: string | null;
  qos: number;
  retain: boolean;
  payload_text: string | null;
  payload_hex: string;
  parsed_json: unknown;
  parser_used: string | null;
  processing_status: string;
  processing_error: string | null;
}
export interface Topic {
  topic: string;
  message_count: number;
  first_seen: string;
  last_seen: string;
}
export interface Signal {
  id: string;
  key: string;
  name: string | null;
  data_type: 'number' | 'boolean' | 'string';
  unit: string | null;
  tag_id: string | null;
  sample_value: unknown;
  last_seen_at: string | null;
  occurrences: number;
  configured: boolean;
}
export interface DashboardWidget {
  id: string;
  device_id: string;
  tag_id: string | null;
  widget_type:
    | 'value'
    | 'line'
    | 'gauge'
    | 'status'
    | 'production'
    | 'oee'
    | 'pareto'
    | 'donut'
    | 'bar_vertical'
    | 'bar_horizontal';
  title: string;
  position: number;
  width: 'small' | 'medium' | 'large' | 'full';
  config: {
    color?: string;
    min?: number;
    max?: number;
    decimals?: number;
    gaugeStyle?: 'top' | 'bottom' | 'left' | 'right';
    alarmEnabled?: boolean;
    warningLow?: number;
    warningHigh?: number;
    gaugeNeedle?: boolean;
    alarmRanges?: Array<{
      id: string;
      label: string;
      start: number;
      end: number;
      color: string;
      priority: number;
    }>;
    productionPeriodMinutes?: number;
    productionMinimumValue?: number;
    productionMetricKind?: 'rate_average' | 'counter_delta';
    productionTrendDays?: 7 | 30;
    /** Period a production chart opens with; each chart can then change it on its own. */
    productionDefaultPeriod?: 'today' | '7d' | 'week' | 'month' | 'year' | '30d' | 'custom';
    /** Quick bar charts: one bar per product in the period, or one bar per day. */
    chartDimension?: 'product' | 'day';
    /** Quick charts: tones of the widget colour (default, sober) or a categorical palette. */
    chartPalette?: 'shades' | 'colorful';
    /** Quick charts: per-product colour overrides, keyed by product code. */
    productColors?: Record<string, string>;
    /** Quick charts: show the top N products and fold the rest into "Outros"; 0 = all. */
    maxProducts?: number;
    /** Grid size set by dragging the card corner: columns of 12 and 64px rows. */
    colSpan?: number;
    rowSpan?: number;
    counterMode?: boolean;
    /** Legacy raw-value offset; ignored since zeroing moved to counterResetAt. */
    counterBaseline?: number;
    /** Server time of the last "Zerar contador"; the display sums increments after it. */
    counterResetAt?: string;
  };
  key: string | null;
  tag_name: string | null;
  unit: string | null;
  data_type: string | null;
}
export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  device_id: string | null;
  device_name?: string;
  device_code?: string;
  site_name?: string;
  site_reference?: string;
  device_online?: boolean;
  device_deactivated?: boolean;
  last_message_at?: string | null;
  refresh_ms: number;
  time_window_minutes: number;
  is_default: boolean;
  widget_count?: number;
  widgets?: DashboardWidget[];
}
export function usePoll<T>(path: string | null, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!path) return;
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? '/api'}${path}`, {
          signal,
          cache: 'no-store',
        });
        if (response.status === 401 && typeof window !== 'undefined') {
          window.location.replace('/login');
          return;
        }
        if (!response.ok) throw new Error(`Serviço indisponível (HTTP ${response.status})`);
        setData(await response.json());
        setError(null);
      } catch (e) {
        if (!(e instanceof Error && e.name === 'AbortError'))
          setError(e instanceof Error ? e.message : 'Falha de conexão');
      }
    },
    [path],
  );
  useEffect(() => {
    setData(null);
    setError(null);
    if (!path) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const started = Date.now();
      controller = new AbortController();
      await refresh(controller.signal);
      if (!disposed)
        timer = setTimeout(() => void tick(), Math.max(0, intervalMs - (Date.now() - started)));
    };
    void tick();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [refresh, intervalMs, path]);
  return { data, error, loading: path !== null && data === null, refresh };
}
export async function mutate<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? '/api'}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && typeof window !== 'undefined') window.location.replace('/login');
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(result.error ?? `Falha na operação (HTTP ${response.status})`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}
export function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('pt-BR') : '—';
}
export function value(sample: Sample) {
  const v = sample.value_number ?? sample.value_boolean ?? sample.value_text;
  return v === null
    ? '—'
    : typeof v === 'boolean'
      ? v
        ? 'Ligado'
        : 'Desligado'
      : typeof v === 'number'
        ? v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
        : v;
}
