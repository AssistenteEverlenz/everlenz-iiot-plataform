import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript embedded into the n8n Code nodes
import { normalizar } from '../infrastructure/n8n/code/normalizador.mjs';
// @ts-expect-error plain JavaScript embedded into the n8n Code nodes
import { montarInstrucao } from '../infrastructure/n8n/code/instrucao.mjs';

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

  it('lets the router talk when it has something to ask', () => {
    expect(normalizar(saida({ tipo_consulta: 'dia' }, 'Pergunte qual equipamento')).acao).toBe('conversa');
    expect(normalizar(saida({ tipo_consulta: 'agora', equipamento: 'capixaba' })).consulta.device).toBe('capixaba');
  });
});

describe('instrução da mensageira', () => {
  const dia = (date: string, made: number) => ({
    date,
    device: 'Cerâmica Capixaba',
    unit: 'paletes',
    made,
    milheiros: made * 0.4,
    pallets: made,
    tons: made * 1.1,
    target: 250,
    targetShare: Math.round((made / 250) * 100),
    utilization: 76,
    stoppedMinutes: 78,
    pacePerHour: 25,
  });

  it('does the comparison arithmetic itself', () => {
    const { instrucao } = montarInstrucao({
      acao: 'producao',
      consulta: { from: '2026-10-10', to: '2026-10-11', tipo: 'comparativo' },
      resposta: { found: true, today: hoje, days: [dia('2026-10-10', 200), dia('2026-10-11', 230)] },
      nome: 'Ana',
    });
    expect(instrucao).toContain('10/10/2026: 200 paletes de 250 (80% da meta)');
    expect(instrucao).toContain('+30 paletes (+15%)');
  });

  it('says today is so far, and lists the machines when one is not found', () => {
    const { instrucao } = montarInstrucao({
      acao: 'producao',
      consulta: { from: hoje, to: hoje, tipo: 'dia' },
      resposta: { found: true, today: hoje, days: [dia(hoje, 120)] },
      nome: 'Ana',
    });
    expect(instrucao).toContain('(hoje, até agora)');
    expect(instrucao).toContain('1h18 parada no turno');
    const missing = montarInstrucao({
      acao: 'agora',
      consulta: { device: 'galo' },
      resposta: { found: false, devices: ['Cerâmica Capixaba'] },
      nome: 'Ana',
    });
    expect(missing.instrucao).toContain('Cerâmica Capixaba');
  });
});
