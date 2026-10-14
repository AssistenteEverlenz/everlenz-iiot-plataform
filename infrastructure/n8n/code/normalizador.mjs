// Normalizador determinístico do roteador do assistente (Code node logo após o "AI Roteador").
//
// O LLM entende a pergunta e extrai os campos; este código decide o que de fato será consultado:
// converte datas ("hoje", "ontem", "15/09", "2026-09-15") para AAAA-MM-DD a partir de DATA_ATUAL,
// completa o que falta com o padrão da pergunta, limita períodos e só deixa passar uma consulta
// que a plataforma consegue responder. Sem rede e sem LLM: testável (tests/n8n-code.test.ts).
//
// ENTRADA: { saida: { messages, dados }, hoje: 'AAAA-MM-DD' }
// SAÍDA:   { acao: 'agora' | 'producao' | 'paradas' | 'conversa', instrucao,
//            consulta: { kind, from, to, dates, device } }
// kind é o que a plataforma responde (/api/n8n/whatsapp/answer): agora, dia, paradas, periodo,
// comparativo. A resposta já vem escrita pela plataforma, no layout do resumo diário.

export function normalizar({ saida, hoje }) {
  const dados = (saida && saida.dados) || {};
  const texto = (v) => String(v == null ? '' : v).trim();
  const messages = texto(saida && saida.messages);

  const iso = (date) => date.toISOString().slice(0, 10);
  const base = new Date(`${hoje}T12:00:00Z`);
  const somaDias = (dia, n) => {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  };
  const semAcento = (v) =>
    texto(v)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

  /** Uma data dita de qualquer jeito, em AAAA-MM-DD; '' quando não dá para entender. */
  function data(valor) {
    const v = semAcento(valor);
    if (!v) return '';
    if (v === 'hoje' || v === 'agora') return hoje;
    if (v === 'ontem') return somaDias(hoje, -1);
    if (v === 'anteontem') return somaDias(hoje, -2);
    let m = v.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = v.match(/^(\d{1,2})[-./](\d{1,2})(?:[-./](\d{2,4}))?$/);
    if (m) {
      let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : base.getUTCFullYear();
      const dia = `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      // "15/12" dito em janeiro é o dezembro que passou.
      if (!m[3] && dia > hoje) ano -= 1;
      return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    return '';
  }
  const valida = (dia) => /^\d{4}-\d{2}-\d{2}$/.test(dia) && !Number.isNaN(new Date(`${dia}T12:00:00Z`).getTime());

  const device = texto(dados.equipamento);
  const conversa = (instrucao) => ({ acao: 'conversa', instrucao, consulta: null });

  // O roteador pediu para conversar (cumprimento, dúvida, dado faltando): segue a instrução dele.
  if (messages) return conversa(messages);

  const tipo = semAcento(dados.tipo_consulta);
  if (tipo === 'agora') return { acao: 'agora', instrucao: '', consulta: { device, kind: 'agora' } };

  if (tipo === 'paradas') {
    const dia = data(dados.data) || hoje;
    if (!valida(dia) || dia > hoje) return conversa('Pergunte, com leveza, de qual dia a pessoa quer ver as paradas.');
    return { acao: 'paradas', instrucao: '', consulta: { from: dia, to: dia, dates: '', device, tipo: 'paradas', kind: 'paradas' } };
  }

  if (tipo === 'dia') {
    const dia = data(dados.data) || hoje;
    if (!valida(dia)) return conversa('Pergunte, com leveza, de qual dia a pessoa quer saber a produção.');
    if (dia > hoje)
      return conversa(`Explique que ${dia.split('-').reverse().join('/')} ainda não aconteceu e pergunte se ela quer outro dia.`);
    return { acao: 'producao', instrucao: '', consulta: { from: dia, to: dia, dates: '', device, tipo: 'dia', kind: 'dia' } };
  }

  if (tipo === 'periodo') {
    let inicio = data(dados.inicio);
    let fim = data(dados.fim) || hoje;
    if (!inicio) return conversa('Pergunte a partir de que dia a pessoa quer o período.');
    if (inicio > fim) [inicio, fim] = [fim, inicio];
    if (fim > hoje) fim = hoje;
    // Mais de 62 dias vira os últimos 62: a resposta ainda cabe numa mensagem.
    if (somaDias(inicio, 61) < fim) inicio = somaDias(fim, -61);
    return { acao: 'producao', instrucao: '', consulta: { from: inicio, to: fim, dates: '', device, tipo: 'periodo', kind: 'periodo' } };
  }

  if (tipo === 'comparativo') {
    const lista = (Array.isArray(dados.datas) ? dados.datas : texto(dados.datas).split(/[,;]| e /))
      .map(data)
      .filter(valida)
      .filter((dia) => dia <= hoje);
    const unicas = [...new Set(lista)].sort();
    if (unicas.length < 2)
      return conversa('Pergunte quais dois dias a pessoa quer comparar (por exemplo "ontem e hoje" ou "10/10 e 11/10").');
    return {
      acao: 'producao',
      instrucao: '',
      consulta: { from: unicas[0], to: unicas.at(-1), dates: unicas.slice(0, 7).join(','), device, tipo: 'comparativo', kind: 'comparativo' },
    };
  }

  return conversa(
    'Diga com simpatia que por aqui dá para perguntar a produção de agora, de um dia, de um período, comparar dias ou ver as paradas, e dê um exemplo curto de cada.',
  );
}
