// Builds the n8n workflow that sends the daily production summary on WhatsApp:
//   node infrastructure/n8n/build-workflow.mjs  ->  infrastructure/n8n/resumo-diario-whatsapp.json
// Kept as a script so the JSON (ids, positions, connections) is generated, never hand-edited.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const config = "$('Configuração').item.json";
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters,
  id: randomUUID(),
  name,
  type,
  typeVersion,
  position,
  ...extra,
});

const nodes = [
  node('Nota', 'n8n-nodes-base.stickyNote', 1, [-80, -260], {
    content:
      '## Resumo diário de produção no WhatsApp\n\n' +
      '1. Preencha **Configuração** (endereço e chave da plataforma, dados da Evolution).\n' +
      '2. Ative o fluxo. A cada 3 min ele pede **uma** mensagem à plataforma.\n\n' +
      'Quem controla o ritmo é a plataforma: ela só entrega mensagens entre **07h e 21h** e com ' +
      'no mínimo **3 min** entre envios, e cada envio ainda espera alguns segundos aleatórios e ' +
      'mostra "digitando". Assim o número não dispara em rajada e não é tratado como spam.\n\n' +
      'Uma falha na Evolution volta para a fila e é tentada de novo (até 3 vezes).',
    height: 300,
    width: 520,
    color: 5,
  }),
  node('A cada 3 minutos', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 100], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 3 }] },
  }),
  node('Configuração', 'n8n-nodes-base.set', 3.4, [220, 100], {
    assignments: {
      assignments: [
        ['PLATAFORMA_URL', 'https://iotplataform.everlenz.com.br'],
        ['PLATAFORMA_CHAVE', 'COLE_AQUI_A_N8N_API_KEY'],
        ['EVOLUTION_URL', 'https://evolutionapi.assistentedrfin.com.br'],
        ['EVOLUTION_INSTANCIA', 'NOME_DA_INSTANCIA'],
        ['EVOLUTION_APIKEY', 'COLE_AQUI_A_APIKEY_DA_EVOLUTION'],
      ].map(([name, value]) => ({ id: randomUUID(), name, value, type: 'string' })),
    },
    options: {},
  }),
  node('Buscar próxima mensagem', 'n8n-nodes-base.httpRequest', 4.2, [440, 100], {
    url: `={{ ${config}.PLATAFORMA_URL }}/api/n8n/production-messages/next`,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'x-n8n-key', value: `={{ ${config}.PLATAFORMA_CHAVE }}` }],
    },
    options: { timeout: 30000 },
  }),
  node('Tem mensagem?', 'n8n-nodes-base.if', 2.2, [660, 100], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: randomUUID(),
          leftValue: '={{ $json.message?.id }}',
          rightValue: '',
          operator: { type: 'string', operation: 'exists', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  }),
  node('Nada para enviar', 'n8n-nodes-base.noOp', 1, [880, 260], {}),
  node('Espera aleatória', 'n8n-nodes-base.wait', 1.1, [880, 0], {
    amount: '={{ $json.message.waitSeconds }}',
  }),
  node(
    'Enviar WhatsApp (Evolution)',
    'n8n-nodes-base.httpRequest',
    4.2,
    [1100, 0],
    {
      method: 'POST',
      url: `={{ ${config}.EVOLUTION_URL }}/message/sendText/{{ encodeURIComponent(${config}.EVOLUTION_INSTANCIA) }}`,
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'apikey', value: `={{ ${config}.EVOLUTION_APIKEY }}` }],
      },
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: 'number', value: "={{ $('Tem mensagem?').item.json.message.number }}" },
          { name: 'text', value: "={{ $('Tem mensagem?').item.json.message.text }}" },
          // Shows "digitando..." for a few seconds, like a person, before the text arrives.
          { name: 'delay', value: '={{ 2000 + Math.floor(Math.random() * 3000) }}' },
          { name: 'presence', value: 'composing' },
          { name: 'linkPreview', value: '={{ false }}' },
        ],
      },
      options: { timeout: 60000 },
    },
    { onError: 'continueErrorOutput' },
  ),
  node('Confirmar envio', 'n8n-nodes-base.httpRequest', 4.2, [1340, -80], {
    method: 'POST',
    url: `={{ ${config}.PLATAFORMA_URL }}/api/n8n/production-messages/{{ $('Tem mensagem?').item.json.message.id }}/result`,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'x-n8n-key', value: `={{ ${config}.PLATAFORMA_CHAVE }}` }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ { ok: true } }}',
    options: {},
  }),
  node('Registrar falha', 'n8n-nodes-base.httpRequest', 4.2, [1340, 120], {
    method: 'POST',
    url: `={{ ${config}.PLATAFORMA_URL }}/api/n8n/production-messages/{{ $('Tem mensagem?').item.json.message.id }}/result`,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'x-n8n-key', value: `={{ ${config}.PLATAFORMA_CHAVE }}` }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      "={{ { ok: false, error: String($json.error?.message ?? $json.message ?? 'falha na Evolution').slice(0, 400) } }}",
    options: {},
  }),
];

const to = (name) => [{ node: name, type: 'main', index: 0 }];
const workflow = {
  name: 'IIoT - Resumo diário de produção no WhatsApp',
  nodes,
  connections: {
    'A cada 3 minutos': { main: [to('Configuração')] },
    Configuração: { main: [to('Buscar próxima mensagem')] },
    'Buscar próxima mensagem': { main: [to('Tem mensagem?')] },
    'Tem mensagem?': { main: [to('Espera aleatória'), to('Nada para enviar')] },
    'Espera aleatória': { main: [to('Enviar WhatsApp (Evolution)')] },
    'Enviar WhatsApp (Evolution)': { main: [to('Confirmar envio'), to('Registrar falha')] },
  },
  active: false,
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none' },
  pinData: {},
  tags: [],
};

writeFileSync(
  new URL('./resumo-diario-whatsapp.json', import.meta.url),
  `${JSON.stringify(workflow, null, 2)}\n`,
);
console.log('resumo-diario-whatsapp.json written');

// The automatic answer of the platform's WhatsApp number. The number only sends the daily
// summary; a person who answers gets one sentence pointing to the panel, once per contact per 24
// hours, so a "thanks" never turns into a conversation and the number never chats in a loop.
// Evolution posts every event of the instance to this webhook (event "messages.upsert").
const reply = {
  name: 'IIoT - Resposta automática do WhatsApp',
  nodes: [
    node('Nota', 'n8n-nodes-base.stickyNote', 1, [-80, -260], {
      content:
        '## Resposta automática do número da plataforma\n\n' +
        '1. Na Evolution, na instância da plataforma, configure o **webhook** com a URL de produção ' +
        'do nó **Mensagem recebida** e o evento **MESSAGES_UPSERT**.\n' +
        '2. Preencha **Configuração** (mesmos dados da Evolution do fluxo do resumo).\n\n' +
        'Responde só a mensagens de pessoas (não grupos, não as próprias), **uma vez por contato a ' +
        'cada 24 h**.',
      height: 260,
      width: 520,
      color: 5,
    }),
    node(
      'Mensagem recebida',
      'n8n-nodes-base.webhook',
      2,
      [0, 100],
      { httpMethod: 'POST', path: 'everlenz-iiot-whatsapp', options: {} },
      { webhookId: randomUUID() },
    ),
    node('Configuração', 'n8n-nodes-base.set', 3.4, [220, 100], {
      assignments: {
        assignments: [
          ['EVOLUTION_URL', 'https://evolutionapi.assistentedrfin.com.br'],
          ['EVOLUTION_INSTANCIA', 'NOME_DA_INSTANCIA'],
          ['EVOLUTION_APIKEY', 'COLE_AQUI_A_APIKEY_DA_EVOLUTION'],
          [
            'RESPOSTA',
            'Olá! Este número só envia o resumo diário de produção da Everlenz IIoT. Para ver os detalhes e acompanhar em tempo real, acesse o painel: https://iotplataform.everlenz.com.br',
          ],
        ].map(([name, value]) => ({ id: randomUUID(), name, value, type: 'string' })),
      },
      options: {},
    }),
    node('Responder a este contato?', 'n8n-nodes-base.code', 2, [440, 100], {
      mode: 'runOnceForAllItems',
      jsCode: [
        "const body = $('Mensagem recebida').first().json.body ?? {};",
        'const data = Array.isArray(body.data) ? body.data[0] : body.data ?? {};',
        "const jid = String(data?.key?.remoteJid ?? '');",
        "const event = String(body.event ?? '').toLowerCase().replace('_', '.');",
        '// Only a person writing to us: not our own sends, not groups, not status.',
        "if (event !== 'messages.upsert' || data?.key?.fromMe || !jid.endsWith('@s.whatsapp.net')) return [];",
        "const memory = $getWorkflowStaticData('global');",
        'memory.answered = memory.answered ?? {};',
        'const now = Date.now();',
        '// Once per contact per day; old entries are forgotten so the memory stays small.',
        'for (const [key, at] of Object.entries(memory.answered)) if (now - at > 86400000) delete memory.answered[key];',
        'if (memory.answered[jid]) return [];',
        'memory.answered[jid] = now;',
        "return [{ json: { number: jid.split('@')[0], waitSeconds: 3 + Math.floor(Math.random() * 6) } }];",
      ].join('\n'),
    }),
    node('Espera curta', 'n8n-nodes-base.wait', 1.1, [660, 100], {
      amount: '={{ $json.waitSeconds }}',
    }),
    node(
      'Enviar resposta',
      'n8n-nodes-base.httpRequest',
      4.2,
      [880, 100],
      {
        method: 'POST',
        url: `={{ ${config}.EVOLUTION_URL }}/message/sendText/{{ encodeURIComponent(${config}.EVOLUTION_INSTANCIA) }}`,
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'apikey', value: `={{ ${config}.EVOLUTION_APIKEY }}` }],
        },
        sendBody: true,
        bodyParameters: {
          parameters: [
            { name: 'number', value: "={{ $('Responder a este contato?').item.json.number }}" },
            { name: 'text', value: `={{ ${config}.RESPOSTA }}` },
            { name: 'delay', value: '={{ 1500 + Math.floor(Math.random() * 2000) }}' },
            { name: 'presence', value: 'composing' },
          ],
        },
        options: { timeout: 60000 },
      },
      { onError: 'continueRegularOutput' },
    ),
  ],
  connections: {
    'Mensagem recebida': { main: [to('Configuração')] },
    Configuração: { main: [to('Responder a este contato?')] },
    'Responder a este contato?': { main: [to('Espera curta')] },
    'Espera curta': { main: [to('Enviar resposta')] },
  },
  active: false,
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none' },
  pinData: {},
  tags: [],
};
writeFileSync(
  new URL('./resposta-automatica-whatsapp.json', import.meta.url),
  `${JSON.stringify(reply, null, 2)}\n`,
);
console.log('resposta-automatica-whatsapp.json written');
