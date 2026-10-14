import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript embedded into the n8n Code nodes
import { normalizar } from '../infrastructure/n8n/code/normalizador.mjs';

/** The deterministic steps of the WhatsApp orchestrator (infrastructure/n8n). */
const hoje = '2026-10-11';
const saida = (dados: Record<string, unknown>, messages = '') => ({ saida: { messages, dados }, hoje });

describe('normalizador do assistente', () => {
  it('reads the days however they are said', () => {
    expect(normalizar(saida({ tipo_consulta: 'dia', data: 'ontem' })).consulta).toMatchObject({ from: '2026-10-10', to: '2026-10-10' });
    expect(normalizar(saida({ tipo_consulta: 'dia', data: '' })).consulta.from).toBe(hoje);
    expect(normalizar(saida({ tipo_consulta: 'dia', data: '5/10' })).consulta.from).toBe('2026-10-05');
    // "15/12" said in October is last December.
    expect(normalizar(saida({ tipo_consulta: 'dia', data: '15/12' })).consulta.from).toBe('2025-12-15');
    expect(normalizar(saida({ tipo_consulta: 'dia', data: '2026-09-30' })).consulta.from).toBe('2026-09-30');
  });

  it('compares two days, and asks when only one is given', () => {
    const ok = normalizar(saida({ tipo_consulta: 'comparativo', datas: 'hoje, ontem' }));
    expect(ok.acao).toBe('producao');
    expect(ok.consulta.dates).toBe('2026-10-10,2026-10-11');
    expect(normalizar(saida({ tipo_consulta: 'comparativo', datas: 'ontem' })).acao).toBe('conversa');
  });

  it('keeps periods inside today and 62 days', () => {
    const p = normalizar(saida({ tipo_consulta: 'periodo', inicio: '01/01/2026', fim: '30/12/2026' }));
    expect(p.consulta.to).toBe(hoje);
    expect(p.consulta.from).toBe('2026-08-11');
  });

  it('asks the platform for the stops of a day, today when no day is said', () => {
    const today = normalizar(saida({ tipo_consulta: 'paradas', data: '' }));
    expect(today.acao).toBe('paradas');
    expect(today.consulta).toMatchObject({ kind: 'paradas', from: hoje });
    expect(normalizar(saida({ tipo_consulta: 'paradas', data: 'ontem' })).consulta.from).toBe('2026-10-10');
    expect(normalizar(saida({ tipo_consulta: 'agora' })).consulta.kind).toBe('agora');
    expect(normalizar(saida({ tipo_consulta: 'periodo', inicio: '01/10' })).consulta.kind).toBe('periodo');
  });

  it('lets the router talk when it has something to ask', () => {
    expect(normalizar(saida({ tipo_consulta: 'dia' }, 'Pergunte qual equipamento')).acao).toBe('conversa');
    expect(normalizar(saida({ tipo_consulta: 'agora', equipamento: 'capixaba' })).consulta.device).toBe('capixaba');
  });
});
