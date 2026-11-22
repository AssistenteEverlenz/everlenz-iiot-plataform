// Entrada do assistente pela API oficial do WhatsApp (Meta Cloud API), Code node logo após o
// WhatsApp Trigger.
//
// O WhatsApp Trigger entrega o "value" do webhook da Meta (messages, contacts, metadata); um
// webhook comum entrega o corpo inteiro (object, entry[].changes[].value). Os dois são aceitos.
// Avisos de status (enviada, entregue, lida) não trazem mensagem e são ignorados.
//
// ENTRADA: os json dos itens do gatilho.
// SAÍDA:   a primeira mensagem de texto, no formato do resto do fluxo:
//          [{ jid: '5547...@s.whatsapp.net', phone: '5547...', text, messageId }] ou [].
// O jid mantém o formato da Evolution para a plataforma (inbound, collect, memória) não mudar.

export function entradaOficial(itens) {
  const valores = [];
  for (const item of itens || []) {
    const corpo = (item && item.body) || item || {};
    if (Array.isArray(corpo.entry)) {
      for (const entry of corpo.entry)
        for (const change of entry.changes || []) valores.push(change.value || {});
    } else valores.push(corpo);
  }
  for (const valor of valores) {
    for (const m of valor.messages || []) {
      let text = '';
      if (m.type === 'text') text = (m.text && m.text.body) || '';
      // Botão de resposta rápida de um template (o "Ver resumo" do resumo diário).
      else if (m.type === 'button') text = (m.button && (m.button.payload || m.button.text)) || '';
      else if (m.type === 'interactive') {
        const i = m.interactive || {};
        text = (i.button_reply && (i.button_reply.id || i.button_reply.title)) || (i.list_reply && i.list_reply.id) || '';
      } else if (m.type === 'image') text = (m.image && m.image.caption) || '';
      text = String(text).trim();
      // "Ver resumo" traz o dia do resumo: vira a pergunta desse dia, que a plataforma responde
      // no layout do resumo diário.
      const resumo = /^resumo:(\d{4}-\d{2}-\d{2})$/.exec(text);
      if (resumo) text = `Como foi a produção do dia ${resumo[1]}?`;
      const phone = String(m.from || '').replace(/\D/g, '');
      if (!phone || !text) continue;
      return [{ jid: `${phone}@s.whatsapp.net`, phone, text, messageId: m.id || null }];
    }
  }
  return [];
}
