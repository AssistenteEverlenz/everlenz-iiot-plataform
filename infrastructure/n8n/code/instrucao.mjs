// Monta a instrução para a mensageira a partir da resposta da plataforma (Code node depois da
// consulta). Todos os números e contas (diferenças, percentuais, totais) são feitos aqui, nunca
// pela IA: a mensageira só dá a voz. Testável (tests/n8n-code.test.ts).
//
// ENTRADA: { acao: 'agora' | 'producao', consulta, resposta, nome }
// SAÍDA:   { instrucao }

export function montarInstrucao({ acao, consulta, resposta, nome }) {
  const num = (v, casas = 0) =>
    v == null || Number.isNaN(Number(v))
      ? '—'
      : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const casasDe = (unidade) => (unidade === 'milheiros' || unidade === 't' ? 1 : 0);
  const br = (dia) => String(dia || '').split('-').reverse().join('/');
  const duracao = (minutos) => {
    const m = Math.round(Number(minutos) || 0);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${h}h`;
  };
  const ESTADOS = {
    producing: 'produzindo',
    idle: 'parada (ociosa)',
    manual: 'parada (em manual)',
    offline: 'sem comunicação',
    unknown: 'sem leitura',
  };
  const linhas = [];

  if (resposta && resposta.found === false) {
    const lista = (resposta.devices || []).join(', ');
    return {
      instrucao: lista
        ? `Diga que não encontrou o equipamento "${consulta.device}" entre os dela e liste os que ela acompanha: ${lista}. Pergunte qual quer.`
        : 'Diga com gentileza que nenhum equipamento está liberado para ela na plataforma e que o administrador pode liberar.',
    };
  }

  if (acao === 'agora') {
    linhas.push(`Responda a ${nome || 'pessoa'} como está a produção AGORA, máquina por máquina, com estes dados:`);
    for (const m of resposta.machines || []) {
      const c = casasDe(m.unit);
      linhas.push(`- ${m.device}: ${ESTADOS[m.state] || m.state}${m.product ? `, produto ${m.product}` : ''}.`);
      linhas.push(`  Produzido hoje até agora: ${num(m.made, c)} ${m.unit}.`);
      if (m.target != null) {
        const pct = m.target > 0 ? Math.round((m.made / m.target) * 100) : 0;
        linhas.push(`  Meta do dia: ${num(m.target, c)} (${pct}% feito; o esperado para agora era ${num(m.expectedNow, c)}).`);
        if (m.shiftStatus === 'running')
          linhas.push(
            `  No ritmo atual fecha em ${num(m.projected, c)} ${m.unit}${m.requiredPerHour != null ? `; para bater precisa de ${num(m.requiredPerHour, c)} ${m.unit}/h` : ''}.`,
          );
        else linhas.push('  O turno de hoje já encerrou.');
      }
      linhas.push(`  Ritmo: ${num(m.pacePerHour, c)} ${m.unit}/h. Aproveitamento da máquina: ${m.utilization == null ? '—' : `${m.utilization}%`}.`);
      linhas.push(`  Paradas hoje: ${m.stops} (${duracao(m.stoppedMinutes)} parada no turno).`);
      if (m.yesterdaySameTime > 0) {
        const dif = Math.round((m.made / m.yesterdaySameTime - 1) * 100);
        linhas.push(`  Ontem até este horário: ${num(m.yesterdaySameTime, c)} (${dif >= 0 ? '+' : ''}${dif}% hoje).`);
      }
    }
    linhas.push('Uma mensagem por máquina se forem várias. Destaque o número produzido e se vai bater a meta.');
    return { instrucao: linhas.join('\n') };
  }

  const dias = resposta.days || [];
  if (!dias.length)
    return {
      instrucao: `Diga que não há produção registrada ${consulta.from === consulta.to ? `em ${br(consulta.from)}` : `entre ${br(consulta.from)} e ${br(consulta.to)}`} (pode ter sido um dia sem turno) e ofereça consultar outro dia.`,
    };
  const porMaquina = new Map();
  for (const d of dias) porMaquina.set(d.device, [...(porMaquina.get(d.device) || []), d]);

  if (consulta.tipo === 'comparativo') {
    linhas.push(`Compare para ${nome || 'a pessoa'} a produção destes dias (os números e diferenças já estão calculados):`);
    for (const [maquina, lista] of porMaquina) {
      const c = casasDe(lista[0].unit);
      linhas.push(`- ${maquina}:`);
      for (const d of lista)
        linhas.push(
          `  ${br(d.date)}: ${num(d.made, c)} ${d.unit}${d.target != null ? ` de ${num(d.target, c)} (${d.targetShare}% da meta)` : ''}; aproveitamento ${d.utilization == null ? '—' : `${d.utilization}%`}; ${duracao(d.stoppedMinutes)} parada.`,
        );
      if (lista.length >= 2) {
        const [a, b] = [lista[0], lista.at(-1)];
        const dif = b.made - a.made;
        const pct = a.made > 0 ? Math.round((b.made / a.made - 1) * 100) : null;
        linhas.push(
          `  Diferença de ${br(b.date)} para ${br(a.date)}: ${dif >= 0 ? '+' : ''}${num(dif, c)} ${a.unit}${pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct}%)`}.`,
        );
      }
    }
    linhas.push('Diga de forma clara qual dia foi melhor.');
    return { instrucao: linhas.join('\n') };
  }

  const unicoDia = consulta.from === consulta.to;
  linhas.push(
    unicoDia
      ? `Responda a ${nome || 'pessoa'} a produção de ${br(consulta.from)}${consulta.from === resposta.today ? ' (hoje, até agora)' : ''}:`
      : `Responda a ${nome || 'pessoa'} a produção de ${br(consulta.from)} a ${br(consulta.to)}:`,
  );
  for (const [maquina, lista] of porMaquina) {
    const c = casasDe(lista[0].unit);
    if (unicoDia) {
      const d = lista[0];
      linhas.push(
        `- ${maquina}: ${num(d.made, c)} ${d.unit}${d.target != null ? ` de ${num(d.target, c)} (${d.targetShare}% da meta)` : ''}.`,
      );
      linhas.push(
        `  Também: ${num(d.milheiros, 1)} milheiros · ${num(d.pallets)} paletes · ${num(d.tons, 1)} t. Aproveitamento ${d.utilization == null ? '—' : `${d.utilization}%`}; ${duracao(d.stoppedMinutes)} parada no turno; ritmo ${num(d.pacePerHour, c)} ${d.unit}/h.`,
      );
    } else {
      const total = (resposta.totals || []).find((t) => t.device === maquina);
      const melhor = [...lista].sort((x, y) => y.made - x.made)[0];
      const pior = [...lista].sort((x, y) => x.made - y.made)[0];
      linhas.push(
        `- ${maquina}: total ${num(total ? total.made : 0, c)} ${lista[0].unit} em ${lista.length} dia(s) de produção${total && total.target ? ` (meta somada ${num(total.target, c)}; ${Math.round((total.made / total.target) * 100)}%)` : ''}; média ${num((total ? total.made : 0) / lista.length, c)} por dia.`,
      );
      linhas.push(`  Melhor dia: ${br(melhor.date)} com ${num(melhor.made, c)}. Menor: ${br(pior.date)} com ${num(pior.made, c)}.`);
    }
  }
  linhas.push('Seja direto: o número principal primeiro.');
  return { instrucao: linhas.join('\n') };
}
