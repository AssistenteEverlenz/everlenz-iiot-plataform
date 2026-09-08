# Estado do projeto — 8 de setembro de 2026

## Produção ativa

A stack está implantada no projeto Coolify **IOT Plataform Everlenz**, ambiente `production`, a partir da branch `main`. A interface está disponível em `https://iotplataform.everlenz.com.br`; web, API, ingestor e Mosquitto estão saudáveis. O broker atende equipamentos em `mqtt.everlenz.com.br:8883` com TLS e autenticação. A porta sem TLS `1883` está vinculada somente ao localhost da VPS.

O Supabase `bootqaxgxxsdfggqivlj` recebeu as migrations `001_initial.sql` e `002_server_only_access.sql`. O seed inicial criou um tenant, um site, dois dispositivos e oito tags. Um teste real publicou uma mensagem com QoS 1 por MQTT/TLS e confirmou sua persistência e leitura pela API. O certificado MQTT é sincronizado diariamente do armazenamento ACME do Traefik, com recarga do broker quando houver renovação.

## Preparação Coolify + Supabase

**Arquitetura atual:** equipamentos → Mosquitto self-hosted na VPS/Coolify → ingestor → Supabase PostgreSQL via `pg`/DATABASE_URL → Fastify → Next.js. O projeto existente foi evoluído; adapters, resolução de dispositivos, RAW, amostras, simuladores e testes foram preservados. Não foi implementada autenticação, RLS, comando remoto ou política de remoção RAW.

### Arquivos alterados/criados

- `packages/database/src/config.ts`, `index.ts`: configuração por DATABASE_URL, pool inicializado somente quando utilizado, TLS com validação de certificado/hostname, CA opcional e ausência de fallback local.
- `packages/database/src/migrate.ts`, `status.ts`, `seed.ts`: db:migrate/db:status/db:seed, checksums, auditoria de arquivos aplicados, preservação de registros legados e tratamento de erro sem imprimir credenciais.
- `packages/database/migrations/002_server_only_access.sql`: revoga privilégios públicos/anon/authenticated somente dos objetos IIoT. `001_initial.sql` foi revisada e mantida; não se ativou RLS.
- `docker-compose.production.yml`: exatamente mosquitto, ingestor, api e web; sem PostgreSQL ou simulador; sem migrations/seed no startup. `docker-compose.operations.yml`: operação de banco deliberada e compilada.
- `docker-compose.yml`: laboratório preservado com PostgreSQL/serviços no profile development; usar explicitamente somente quando quiser o banco local. Produção não depende desse arquivo/volume.
- `Dockerfile`, manifests de packages, `pnpm-workspace.yaml`, lockfile e `scripts/build-service.mjs`: imagens multi-stage com targets api/ingestor/web/database-tools, JavaScript compilado, dependências de produção, pnpm injected workspace e Next standalone. O runtime não usa tsx.
- `infrastructure/mosquitto/Dockerfile`, `production-entrypoint.sh`, configuração TLS: persistência de config/ACL, senhas e dados; TLS e TCP, logs stdout/arquivo, encaminhamento de sinais. Templates inicializam volumes somente uma vez.
- `packages/shared/src/index.ts`, `apps/ingestor/src/*`, `apps/api/src/*`: hosts MQTT interno/público, eventos estruturados, healthchecks discriminando dependências e encerramento por sinais. Simulador/E2E usam host público quando configurado.
- `apps/web/next.config.ts`, `app/health/route.ts`, `production.mjs`: build standalone e saúde própria; frontend não recebe DATABASE_URL nem secrets Supabase/MQTT.
- `.env.example`, `scripts/setup.mjs`, arquivos ignore, `scripts/validate-production.mjs`, workflow CI: configuração documentada, laboratório explícito, exclusão de secrets das imagens e validação sem credenciais reais.
- `infrastructure/coolify/deployment.json`, `docs/deployment/coolify.md`, `docs/architecture/supabase.md`, `data-retention.md`, README e roteiro Haiwell: contrato para agente, deployment/rollback, índices, retenção e captura real na infraestrutura nova.
- `tests/database-config.test.ts`, `tests/migrations.integration.test.ts`: TLS, URL, saúde e grants/auditoria. Os testes anteriores continuam presentes.

### Banco, secrets e portas

DATABASE_URL deve ser a URL real de Direct Connection ou Supavisor Session Mode, com senha URL-encoded; não presumimos domínio. TLS é validado; CA adicional pode ser fornecida por DATABASE_SSL_CA_PEM ou FILE. `sslmode=disable` só é aceito explicitamente fora de produção. O build/testes não exigem banco nem secrets.

Servidor: DATABASE_URL, MQTT_PASSWORD e MQTT_SIMULATOR_PASSWORD; CA se necessária. Configuração: DEV_TENANT_ID, domínio web, domínio API opcional, MQTT_PUBLIC_HOST e regras de rede. No Coolify, o certificado MQTT usa o bind fixo `/data/coolify/certificates/mqtt.everlenz.com.br`, provisionado pelo sincronizador do Traefik. SUPABASE_URL/SECRET_KEY e NEXT_PUBLIC_SUPABASE_URL/PUBLISHABLE_KEY estão preparados, mas não são utilizados nesta versão; não precisamos de chave administrativa Supabase para o deployment.

Coolify publica web/API pelo proxy HTTP nas portas internas 3000/3001. O ingestor não publica porta host. Mosquitto publica **1883:1883** e **8883:8883** por padrão: restringir 1883 por firewall efetivo da VPS/Docker, VPN ou bind controlado antes de iniciar. O ingestor usa `mosquitto:1883` pela rede interna. TLS MQTT exige certificado próprio montado; o proxy HTTP não o fornece automaticamente.

### Validação desta etapa

- `pnpm lint`, `pnpm format:check`: aprovados.
- `pnpm test`: **51 testes unitários aprovados**.
- `pnpm test:integration`: **14 testes aprovados** com PostgreSQL/PGlite, incluindo as duas migrations, seed, status somente leitura, checksum divergente, revogação de grants e fluxo RAW → adapter → samples → API.
- `pnpm build` com `IIOT_LOAD_ENV=false`: aprovado sem PostgreSQL local e sem secrets reais, incluindo CLI de banco compilada e Next standalone.
- Docker Compose oficial **v5.5.1**, baixado da distribuição oficial e SHA-256 verificado: `config --quiet` aprovado para produção, operações e laboratório. `pnpm docker:production:validate` confirmou quatro serviços, ausência de banco/simulador, portas e escopo de secrets com valores fictícios.
- Empacotamento `pnpm deploy --prod` e smoke tests dos artefatos isolados de API/ingestor/web/CLI de banco executados. API/ingestor reportaram 503 com dependências indisponíveis; web respondeu 200; db:status compilado tratou configuração ausente sem imprimir secret nem executar migrations.

As imagens Linux e o deployment real foram validados na VPS Coolify. HTTPS da web e da API respondeu `200`; os quatro containers ficaram saudáveis; o handshake e a autenticação MQTT/TLS foram confirmados externamente; e o fluxo broker → ingestor → Supabase → API foi verificado. A captura do equipamento Haiwell A7 físico continua como próxima homologação, pois seu formato proprietário permanece tratado como hipótese até recebermos uma mensagem RAW real.

### Próximos passos e handoff

1. Receber URL/token API Coolify, projeto/ambiente/servidor/destination e repositório/branch com acesso autorizado.
2. Receber DATABASE_URL do Supabase alvo e CA se exigida; conferir colisões de tabelas e backup antes das migrations. Não criar um segundo banco.
3. Confirmar domínios/DNS/IP da VPS, portas livres, firewall/origens permitidas e acesso HTTP restrito enquanto não há autenticação.
4. Disponibilizar certificados MQTT e diretório na VPS; senhas MQTT distintas ou autorização para gerá-las nos secrets Coolify; tenant e decisão de seed POC.
5. Executar status/migrations/status como etapa única, depois deployment, healthchecks, simulador externo e captura A7 em janela de discovery controlada.

A [lista completa e exata de credenciais/informações](docs/deployment/coolify.md#handoff-exato-para-um-agente-com-acesso) inclui condicionais para DNS/VPS/A7. Nenhum valor real foi registrado aqui. Paramos antes do deployment, conforme solicitado.

---

## Registro histórico — entrega inicial local (7 de setembro)

As seções abaixo preservam os resultados e limitações da primeira etapa. Afirmações sobre banco local/ausência de Supabase descrevem aquela versão; a arquitetura vigente é a seção acima.

## Resultado

A estrutura inicial foi criada diretamente neste workspace e as dependências foram instaladas. Lint, TypeScript, testes unitários, integração SQL e build foram executados. O fluxo Mosquitto/Docker ainda **não foi validado**: Docker não está instalado/disponível neste ambiente. Não há confirmação de telemetria recebida de uma Haiwell A7 real.

O projeto não usa Supabase, Firebase, broker SaaS, Redis, Kafka nem serviços cloud obrigatórios. É somente monitoramento/leitura.

## O que foi criado

- Monorepo pnpm/TypeScript com quatro aplicações e três packages, lockfile, ESLint, Prettier e configuração de build.
- Mosquitto self-hosted em Compose, autenticação obrigatória, geração de arquivo de senhas, ACL de serviços/dispositivo, volumes, limites de pacote/fila, healthcheck e overlay opcional TLS 8883.
- PostgreSQL 17 com migrations SQL transacionais, índices, FKs compostas por tenant e seed idempotente.
- Ingestor independente: reconexão, sessão persistente, modo normal/discovery, captura RAW anterior ao parsing, normalização, escrita em lote por mensagem, estado dos dispositivos, retry de armazenamento, healthcheck e encerramento por sinais.
- Interface MqttAdapter; GenericJsonAdapter; HaiwellAdapter marcado `HAIWELL_FORMAT_HYPOTHESIS`; UnknownAdapter/fallback.
- DeviceResolver extensível com mapping exato, pattern MQTT, project/group/terminal e estrutura de tópicos da plataforma; quarentena de ambiguidade.
- Simuladores genérico e Haiwell com valores variáveis e intervalo configurável.
- Fastify API de leitura, Zod, filtros/paginação, contexto de tenant fixado no servidor e diagnóstico operador de RAW não resolvido.
- Next.js App Router/Tailwind/Recharts: visão geral, dispositivos, detalhe com valores/gráfico e MQTT Inspector; polling de cinco segundos e tratamento de erro/conteúdo vazio.
- Testes unitários, integração SQL/API, script E2E para broker real e workflow GitHub Actions que sobe Compose. O workflow foi escrito, mas não executado neste ambiente.
- README de instalação/operação, arquitetura, segurança, documentação Haiwell e roteiro/template de captura real.
- `.env` local gerado com senhas aleatórias e ignorado pelo Git. Nenhuma senha foi impressa na entrega.

## Arquitetura e decisões

Publicador MQTT → Mosquitto → ingestor → RAW durável → DeviceResolver → adapter configurado → tipos/escala das tags → telemetry_samples → API → dashboard.

RAW usa hexadecimal em todas as mensagens para conservar os bytes exatos. UTF-8 estrito e JSON são representações auxiliares. Erros de JSONB/Unicode/nesting não impedem a gravação inicial RAW. Uma tag inválida impede gravação parcial de amostras da mensagem, mantendo o erro para análise.

SQL direto com pg evita um ORM na ingestão. TelemetryRepository permite ampliar batching. Não há lógica Haiwell na API ou no frontend. FKs compostas impedem associar dispositivos/tags de tenants diferentes; todas as consultas HTTP usam contexto de tenant do servidor, sem aceitar seleção por header/query string. A aplicação ainda não implementa autenticação de usuários.

O backend gera bundles JavaScript com esbuild e roda em Node.js nos containers; `tsx` é usado no desenvolvimento e scripts de banco. Next.js gera build de produção. PGlite executa PostgreSQL em WASM exclusivamente nos testes.

## Validação realizada

`pnpm format:check` também foi aprovado: todos os arquivos verificados seguem o Prettier. O servidor web usado para o smoke test foi encerrado ao terminar a verificação.

| Verificação                                         | Resultado observado                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Instalação pnpm 10.28.2 e dependências              | Concluída; pnpm instalado localmente em `.tools/pnpm`                                                                            |
| `pnpm lint`                                         | Aprovado: ESLint + TypeScript do backend e frontend                                                                              |
| `pnpm test`                                         | 37 testes unitários aprovados                                                                                                    |
| `pnpm test:integration`                             | 13 testes aprovados, PostgreSQL via PGlite                                                                                       |
| Migrations e seed em PGlite                         | Executados, com repetição idempotente validada                                                                                   |
| Integração dos dois formatos                        | Payload do simulador → RAW → adapter → quatro amostras → consulta API, aprovada no harness SQL; sem transporte MQTT              |
| Mensagens inválidas                                 | JSON inválido, binário, NUL, Unicode escapado inválido, nesting profundo, tipos inválidos e mensagem válida seguinte verificados |
| Multi-tenancy                                       | Consultas e tentativa de associação SQL entre tenants verificadas                                                                |
| `pnpm build`                                        | Aprovado: bundles API/ingestor/simulador e build Next.js com rotas estáticas/dinâmicas                                           |
| API compilada em processo Node                      | Iniciada em porta isolada; validação HTTP 400 e health 503 com dependências ausentes, conforme esperado                          |
| Frontend de produção                                | Servidor iniciado; `/`, `/devices`, `/devices/:id` e `/mqtt-inspector` retornaram HTTP 200 e HTML                                |
| YAML de Compose/overlay/CI                          | Parsing estático aprovado; não equivale a `docker compose config` nem a execução dos containers                                  |
| `docker compose up -d --build --wait`               | Bloqueado: comando Docker inexistente; executável também ausente dos caminhos padrão do Docker Desktop                           |
| `pnpm db:migrate` e `pnpm db:seed` contra TCP local | Tentados; `ECONNREFUSED 127.0.0.1:5432`, pois não há PostgreSQL da stack iniciado                                                |
| `pnpm test:e2e`                                     | Tentado; `ECONNREFUSED 127.0.0.1:1883`, pois não há Mosquitto iniciado                                                           |
| Navegador/inspeção visual                           | Runtime de navegador sem browsers disponíveis; não houve validação visual/interativa                                             |
| A7 física e TLS da A7                               | Não testados; dependem do equipamento real                                                                                       |

O build com esbuild precisou ser executado fora da restrição de leitura do sandbox, que impedia percorrer diretórios ancestrais do workspace. A execução autorizada passou. Não se alterou a política de execução do PowerShell; foram usados executáveis `.cmd`.

## Comandos de execução

Com Docker Desktop/Engine instalado e iniciado:

```sh
pnpm install --frozen-lockfile
pnpm env:setup
pnpm docker:up
pnpm simulator:haiwell
```

Dashboard: `http://localhost:3000`. Inspector: `http://localhost:3000/mqtt-inspector`.

Em outro terminal, execute `pnpm test:e2e` para verificar publicações reais dos dois formatos, persistência no PostgreSQL, API e rotas do frontend. `pnpm simulator:generic` inicia o segundo formato. `pnpm docker:down` para sem apagar volumes.

Para desenvolvimento: `pnpm docker:infra`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`. Não rode uma segunda cópia dos serviços nas mesmas portas. Todos os comandos e filtros estão detalhados no [README](README.md).

## Pendências para concluir a validação solicitada

1. Disponibilizar Docker Desktop/Engine com containers Linux neste computador.
2. Executar Compose, conferir saúde dos serviços e aplicar migrations/seed na instância PostgreSQL real.
3. Executar `pnpm test:e2e`; confirmar autenticação/ACL do broker e os dois simuladores em transporte MQTT real.
4. Conferir no navegador o Inspector, polling, valores e gráficos, inclusive em tela móvel; não houve navegador conectado nesta sessão.
5. Executar o roteiro da A7 real e registrar evidências de protocolo/formato/TLS.

## Riscos e próximos passos

- Configuração Docker, permissões de volumes e TLS estão implementadas, porém ainda sem teste de execução neste ambiente. Não tratar imagens/healthchecks como homologados.
- Autenticação/autorizações de usuários e RLS ainda não existem. Contexto fixo e papel operador são para laboratório; endpoints devem permanecer restritos à máquina/rede controlada.
- QoS 1 pode duplicar mensagens. Não existe deduplicação global/exactly-once; uma interrupção pode deixar RAW `pending`. Criar reprocessamento/recuperação antes de produção.
- QoS entregue ao ingestor é registrado; não prova o QoS original da publicação. `online` significa comunicação recente.
- Não há garantia de buffering em QoS 0; broker tem limites de pacote e fila. Testar carga, saturação, reconexão e indisponibilidade do banco antes de uso contínuo.
- RAW/histórico ainda não têm retenção automática, particionamento nem agregação. Gráfico mostra até 500 amostras mais recentes por variável no intervalo. Planejar backups testados e controle de disco.
- Uma única instância de ingestor é o alvo atual. Ampliação exige coordenação de assinaturas e estratégia de batching/cache.
- Payload, encoding, timezone, Client ID, versão MQTT, keepalive, retained, buffering e reenvio histórico da A7 continuam desconhecidos até captura em campo. Não foi afirmado suporte TLS da unidade.

Consulte [arquitetura](docs/architecture/README.md), [segurança MQTT](docs/architecture/mqtt-security.md) e [primeiro teste real](docs/haiwell/first-real-device-test.md).
