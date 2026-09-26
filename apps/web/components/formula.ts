// Calculated fields: a small formula the ceramist writes to turn the HMI's variables into the
// number the plant actually talks about. The cutter, for instance, gives pieces per hour, but
// the operator reasons in cuts per minute: "PecasPorHora / 60 / 24".
//
// The formula is read and evaluated here, never with eval: only numbers, the device's variable
// names, + - * / % ^, parentheses and a few functions get through, so a formula is data like
// any other setting.

export type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: '-'; operand: FormulaNode }
  | { kind: 'binary'; operator: string; left: FormulaNode; right: FormulaNode }
  | { kind: 'call'; name: string; args: FormulaNode[] };

export const FORMULA_FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  abs: (args) => Math.abs(args[0]),
  round: (args) => {
    const places = args.length > 1 ? Math.max(0, Math.min(6, Math.round(args[1]))) : 0;
    const factor = 10 ** places;
    return Math.round(args[0] * factor) / factor;
  },
  floor: (args) => Math.floor(args[0]),
  ceil: (args) => Math.ceil(args[0]),
  /** Zero is a real reading, not an error: this keeps a division from blowing up the card. */
  div: (args) => (args[1] === 0 ? 0 : args[0] / args[1]),
};

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'comma' };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_.]/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === ' ' || char === '\t' || char === '\n') {
      index += 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let text = '';
      while (index < input.length && /[0-9]/.test(input[index])) text += input[index++];
      // Both the comma and the dot write a decimal here: the ceramist types 7,5.
      if (input[index] === '.' || input[index] === ',') {
        index += 1;
        text += '.';
        while (index < input.length && /[0-9]/.test(input[index])) text += input[index++];
      }
      tokens.push({ type: 'number', value: Number(text) });
      continue;
    }
    if (NAME_START.test(char)) {
      let text = '';
      while (index < input.length && NAME_PART.test(input[index])) text += input[index++];
      tokens.push({ type: 'name', value: text });
      continue;
    }
    if ('+-*/%^'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }
    if (char === ';') {
      tokens.push({ type: 'comma' });
      index += 1;
      continue;
    }
    throw new Error(`Caractere não aceito na fórmula: ${char}`);
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

/** Reads a formula and says what is wrong with it, in the words of whoever writes it. */
export function parseFormula(input: string): FormulaNode {
  const tokens = tokenize(input);
  let index = 0;
  const peek = () => tokens[index];
  const expect = (test: (token: Token) => boolean, message: string) => {
    const token = peek();
    if (!token || !test(token)) throw new Error(message);
    index += 1;
    return token;
  };

  const parseExpression = (minimum = 0): FormulaNode => {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (!token || token.type !== 'operator') break;
      const precedence = PRECEDENCE[token.value];
      if (precedence == null || precedence < minimum) break;
      index += 1;
      // "^" groups to the right (2^3^2 is 2^9), the others to the left.
      const right = parseExpression(token.value === '^' ? precedence : precedence + 1);
      left = { kind: 'binary', operator: token.value, left, right };
    }
    return left;
  };

  function parseUnary(): FormulaNode {
    const token = peek();
    if (token?.type === 'operator' && (token.value === '-' || token.value === '+')) {
      index += 1;
      const operand = parseUnary();
      return token.value === '-' ? { kind: 'unary', operator: '-', operand } : operand;
    }
    return parsePrimary();
  }

  function parsePrimary(): FormulaNode {
    const token = peek();
    if (!token) throw new Error('A fórmula terminou antes da hora.');
    if (token.type === 'number') {
      index += 1;
      return { kind: 'number', value: token.value };
    }
    if (token.type === 'paren' && token.value === '(') {
      index += 1;
      const inner = parseExpression();
      expect((next) => next.type === 'paren' && next.value === ')', 'Falta fechar um parêntese.');
      return inner;
    }
    if (token.type === 'name') {
      index += 1;
      const next = peek();
      if (next && next.type === 'paren' && next.value === '(') {
        const name = token.value.toLowerCase();
        if (!FORMULA_FUNCTIONS[name]) throw new Error(`Função desconhecida: ${token.value}`);
        index += 1;
        const args: FormulaNode[] = [];
        if (!(peek()?.type === 'paren' && (peek() as { value: string }).value === ')')) {
          args.push(parseExpression());
          while (peek()?.type === 'comma') {
            index += 1;
            args.push(parseExpression());
          }
        }
        expect((item) => item.type === 'paren' && item.value === ')', 'Falta fechar um parêntese.');
        return { kind: 'call', name, args };
      }
      return { kind: 'variable', name: token.value };
    }
    throw new Error('Não entendi um trecho da fórmula.');
  }

  const node = parseExpression();
  if (index < tokens.length) throw new Error('Sobrou um trecho no fim da fórmula.');
  return node;
}

/** Variable names a formula reads, so a card can tell which ones it still needs. */
export function formulaVariables(node: FormulaNode): string[] {
  const names = new Set<string>();
  const walk = (item: FormulaNode) => {
    if (item.kind === 'variable') names.add(item.name);
    else if (item.kind === 'unary') walk(item.operand);
    else if (item.kind === 'binary') {
      walk(item.left);
      walk(item.right);
    } else if (item.kind === 'call') item.args.forEach(walk);
  };
  walk(node);
  return [...names];
}

function evaluateNode(node: FormulaNode, values: Record<string, number | null | undefined>): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable': {
      const value = values[node.name] ?? values[canonicalVariable(node.name)];
      if (value == null || !Number.isFinite(Number(value)))
        throw new Error(`Sem leitura de ${node.name}`);
      return Number(value);
    }
    case 'unary':
      return -evaluateNode(node.operand, values);
    case 'call':
      return FORMULA_FUNCTIONS[node.name](node.args.map((arg) => evaluateNode(arg, values)));
    case 'binary': {
      const left = evaluateNode(node.left, values);
      const right = evaluateNode(node.right, values);
      if (node.operator === '+') return left + right;
      if (node.operator === '-') return left - right;
      if (node.operator === '*') return left * right;
      if (node.operator === '^') return left ** right;
      // Dividing by zero gives no number: the card shows a dash instead of infinity.
      if (right === 0) throw new Error('Divisão por zero');
      return node.operator === '/' ? left / right : left % right;
    }
  }
}

/** The formula's value, or null when a variable has no reading yet or the maths breaks down. */
export function evaluateFormula(
  input: string,
  values: Record<string, number | null | undefined>,
): number | null {
  if (!input.trim()) return null;
  try {
    const value = evaluateNode(parseFormula(input), values);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Reads a formula only to check it: returns the problem to show, or null when it is fine. */
export function formulaError(input: string, known: string[]): string | null {
  if (!input.trim()) return null;
  try {
    const node = parseFormula(input);
    const unknown = formulaVariables(node).filter(
      (name) => !known.includes(name) && !known.includes(canonicalVariable(name)),
    );
    if (unknown.length) return `Variável não encontrada: ${unknown.join(', ')}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Fórmula inválida.';
  }
}

// Variable names: ihm.<key> for the HMI's own readings and painel.<name> for what the platform
// works out on the production board. Formulas written before the prefixes (a bare HMI key,
// turno.*, and the first operations card's dia.* and ProduzidoHoje-style names) still read.
const LEGACY_NAMES: Record<string, string> = {
  'dia.produzido': 'painel.produzido',
  'dia.meta': 'painel.meta',
  'dia.projecao': 'painel.projecao',
  'dia.ritmo': 'painel.ritmo',
  'dia.eficiencia': 'painel.aproveitamento',
  'dia.pecas': 'painel.pecas',
  'dia.paletes': 'painel.paletes',
  'dia.toneladas': 'painel.toneladas',
  ProduzidoHoje: 'painel.produzido',
  Meta: 'painel.meta',
  Projecao: 'painel.projecao',
  Ritmo: 'painel.ritmo',
  Eficiencia: 'painel.aproveitamento',
};

/** The standard name of a variable written in any of its older spellings. */
export function canonicalVariable(name: string) {
  if (name.startsWith('ihm.') || name.startsWith('painel.')) return name;
  if (name.startsWith('turno.')) return `painel.${name.slice('turno.'.length)}`;
  return LEGACY_NAMES[name] ?? `ihm.${name}`;
}

/** The formula rewritten with the standard names, for an editor to show and save. */
export function modernizeFormula(input: string) {
  return input.replace(
    /(^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_.]*)/g,
    (whole, before: string, name: string, offset: number, text: string) => {
      const after = text.slice(offset + whole.length).trimStart();
      // A function call keeps its name: round(...), max(...).
      if (after.startsWith('(') || name in FORMULA_FUNCTIONS) return whole;
      return before + canonicalVariable(name);
    },
  );
}
