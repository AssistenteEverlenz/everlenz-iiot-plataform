import { describe, expect, it } from 'vitest';
import {
  evaluateFormula,
  formulaError,
  formulaVariables,
  parseFormula,
} from '../apps/web/components/formula.js';

describe('calculated fields', () => {
  // The cutter: 10800 pieces per hour, 6 cuts of 4 blocks each, so 7,5 cuts per minute.
  const cuts = 'PecasPorHora / 60 / (4 * 6)';
  it('reads the formula the ceramist writes', () =>
    expect(evaluateFormula(cuts, { PecasPorHora: 10800 })).toBe(7.5));
  it('accepts a comma as the decimal point', () =>
    expect(evaluateFormula('Peso * 1,5', { Peso: 2 })).toBe(3));
  it('respects precedence and parentheses', () => {
    expect(evaluateFormula('2 + 3 * 4', {})).toBe(14);
    expect(evaluateFormula('(2 + 3) * 4', {})).toBe(20);
    expect(evaluateFormula('2 ^ 3 ^ 2', {})).toBe(512);
    expect(evaluateFormula('-Peso + 10', { Peso: 4 })).toBe(6);
  });
  it('offers a few functions, with ; between arguments', () => {
    expect(evaluateFormula('round(7.456; 2)', {})).toBe(7.46);
    expect(evaluateFormula('max(Pecas; 100)', { Pecas: 40 })).toBe(100);
  });
  it('shows nothing instead of infinity or a missing reading', () => {
    expect(evaluateFormula('Pecas / Paletes', { Pecas: 10, Paletes: 0 })).toBeNull();
    expect(evaluateFormula('Pecas * 2', {})).toBeNull();
  });
  // The platform offers its own numbers beside the HMI ones, named with a dot.
  it("reads the platform's own variables, like turno.pecas", () => {
    expect(
      evaluateFormula('turno.pecas / turno.horas_produzindo', {
        'turno.pecas': 65160,
        'turno.horas_produzindo': 6,
      }),
    ).toBe(10860);
    expect(formulaError('turno.pecas / turno.horas', ['turno.pecas'])).toMatch(/não encontrada/);
  });
  it('lists the variables a formula needs', () =>
    expect(formulaVariables(parseFormula(cuts))).toEqual(['PecasPorHora']));
  it('explains what is wrong before it is saved', () => {
    expect(formulaError('PecasPorHora / ', ['PecasPorHora'])).toMatch(/terminou/);
    expect(formulaError('(2 + 3', [])).toMatch(/parêntese/);
    expect(formulaError('Inexistente * 2', ['PecasPorHora'])).toMatch(/não encontrada/);
    expect(formulaError('PecasPorHora / 60', ['PecasPorHora'])).toBeNull();
  });
  it('refuses anything that is not maths', () => {
    expect(formulaError('process.exit(1)', [])).toMatch(/desconhecida|inválida|entendi/i);
    expect(formulaError('1 && 2', [])).toMatch(/não aceito/);
  });
});
