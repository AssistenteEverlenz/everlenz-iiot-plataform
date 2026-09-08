# Arquitetura

Atualização: produção usa Mosquitto/ingestor/API/web na VPS Coolify e PostgreSQL remoto do Supabase via pg/DATABASE_URL. O Compose local agora é opcional, profile development; não integra o deployment definitivo. Consulte [Supabase](supabase.md), [retenção](data-retention.md) e [deployment](../deployment/coolify.md). Migrations são etapa controlada, nunca startup das réplicas.

## Limites dos componentes

`apps/ingestor` é o consumidor MQTT independente; `apps/api` é somente leitura HTTP; `apps/web` usa App Router, Tailwind, Recharts e polling de 5 segundos; `apps/simulator` é um publicador substituível por equipamento real.

`packages/shared` contém configuração, tipos, logs e conversão de tags. `packages/adapters` contém a interface MqttAdapter, adapters genérico/Haiwell/fallback e DeviceResolver. `packages/database` contém conexão pg, transações, migrations SQL e seed. Não há dependência de marca na API nem no frontend.

## Recepção e normalização

1. O broker autentica o publicador e verifica sua ACL.
2. O ingestor recebe tópico e metadados MQTT. O callback de `handleMessage` só termina depois da persistência/resultado do processamento; indisponibilidade de armazenamento causa retry com backpressure.
3. RAW é inserido em transação própria, inicialmente `pending`. Hexadecimal preserva **todos os bytes**, inclusive UTF-8 válido. Texto usa decoder estrito; JSON é tentado separadamente. NUL não é permitido em text/jsonb do PostgreSQL: nesse caso o hexadecimal mantém a captura exata.
4. DeviceResolver reúne candidatos por mapping exato, pattern MQTT, hipótese Haiwell ou estrutura `iiot/{tenant}/{site}/{device}/{channel}`. Mais de um candidato causa quarentena, sem prioridade implícita que possa escolher o tenant errado.
5. O tenant e dispositivo resolvidos são associados ao RAW. Atualiza-se a última comunicação mesmo se o formato for desconhecido.
6. Apenas o adapter configurado do dispositivo interpreta o payload. Ele retorna valores ainda sem coerção de tipo da tag.
7. Tags habilitadas definem número/boolean/string, escala e offset. Um valor inválido impede toda a escrita normalizada daquela mensagem, preservando RAW com erro. Tags não cadastradas ficam no RAW e são registradas em `processing_error`, sem criação automática.
8. O repositório insere as amostras da mensagem em um único INSERT e atualiza RAW para `processed` na mesma transação.

Estados: `pending` (capturada), `processed` (ao menos uma tag gravada), `unrecognized` (sem resolução/parser/tags), `error` (falha de parsing/conversão/SQL após captura). Um RAW reconhecido parcialmente pode ficar `processed` com aviso sobre tags não cadastradas.

## Garantias e limites de entrega

O consumidor solicita QoS 1. O QoS armazenado é o QoS **entregue pelo broker ao ingestor**, que pode diferir do QoS do publicador. `retain` também representa o pacote recebido, não um comando remoto. Mosquitto aplica limite de 1 MiB por pacote e fila persistente de 10 mil mensagens; exceder esses limites não tem garantia de retenção.

Client ID estável e sessão MQTT persistente ajudam em reconexões. RAW pode repetir em redelivery, especialmente em falhas entre persistência e ACK. Não existe promessa de exactly-once ponta a ponta, nem deduplicação de amostras entre RAWs diferentes. A unicidade `(raw_message_id, tag_id)` apenas impede duplicação dentro do mesmo processamento.

Queda após a inserção RAW pode deixar `pending`; queda/erro na atualização de resultado pode levar ao retry do pacote e novo RAW. Planejar worker de recuperação/reprocessamento por ID antes de produção. QoS 0 não garante recuperação durante indisponibilidade. O banco é o destino durável primário; não há spool em disco adicional nem fila externa.

Ao sair de discovery, o ingestor remove a assinatura `#` persistente. Mudanças arbitrárias de filtros normais exigem revisar/remover assinaturas antigas da sessão ou iniciar um novo Client ID e limpar a sessão antiga no broker durante janela controlada. Escalar ingestors exige assinaturas compartilhadas/particionamento e identidade distinta; não basta duplicar o container.

## Multi-tenancy

FKs compostas impedem relacionamentos site/device/tag/amostra de tenants diferentes. RAW resolvido possui tenant; RAW não resolvido fica em quarentena global. API usa exclusivamente contexto de tenant definido no servidor, com SQL parametrizado. Testes verificam tentativa de acesso usando UUID de outro tenant e headers forjados.

`OPERATOR_RAW_ACCESS` dá visibilidade adicional aos RAWs ainda sem tenant, somente para diagnóstico local. Não expõe RAW resolvido de outro tenant. Não deve ser configurável pelo navegador. O ingestor e o banco de laboratório são infraestrutura confiável com acesso global; não há RLS/roles PostgreSQL por tenant neste MVP. Próxima etapa de produção: autenticação de usuário, autorização central, papel operador explícito, usuário SQL de menor privilégio e RLS como defesa adicional.

## Evolução

O contrato Database permite substituir infraestrutura nos testes sem reescrever o pipeline. TelemetryRepository tem `insertBatch` e aceita evolução para batching entre mensagens. Adapters e ResolutionStrategy são extensíveis; adicionar fabricante não altera dashboard/API. Mais adiante: cache invalidável de cadastro, retenção/particionamento de RAW e samples, agregações por janela, paginação por cursor, métricas, armazenamento de longo prazo e processamento assíncrono. Redis/Kafka não são necessários nesta base.

O volume bruto cresce sem política automática de limpeza. Definir backups testados, retenção, monitoramento de disco e limites de carga antes de operação contínua. PostgreSQL superuser do Compose é uma conveniência de laboratório.
