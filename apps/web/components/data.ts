'use client';
import { useCallback, useEffect, useState } from 'react';
export interface Device {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  online: boolean;
  last_message_at: string | null;
  adapter_type: string;
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
export function usePoll<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? '/api'}${path}`, {
          signal,
          cache: 'no-store',
        });
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
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, refresh };
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
