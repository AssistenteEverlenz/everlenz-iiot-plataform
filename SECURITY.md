# Segurança — estado, correções aplicadas e pendências

Documento de rastreamento da revisão de segurança de **9 de setembro de 2026**, feita sobre
o commit `03fc5d8`. Serve como fonte única para continuar o trabalho.

Numeração estável: os itens mantêm o número original da revisão mesmo depois de resolvidos.
Comentários no código referenciam esses números como `SECURITY.md item N`.

> **Escopo desta branch (`security/hardening-sprint-0`):** apenas segurança. Nenhuma mudança
> de produto, schema, painel ou ingestão. Ver [Coordenação entre agentes](#coordenação-entre-agentes).

---

## Validação executada nesta entrega

| Verificação | Resultado |
| --- | --- |
| `pnpm lint` (ESLint + TypeScript do monorepo e do frontend) | aprovado |
| `pnpm format:check` | aprovado |
| `pnpm test` | **51 testes unitários aprovados** |
| `pnpm test:integration` | **17 testes aprovados** (PGlite) |
| `pnpm build` (`IIOT_LOAD_ENV=false`) | aprovado, incluindo Next standalone |
| Verificação de runtime do rate limit | **confirmada**: 10 requisições aceitas, seguintes com `429` |
| Verificação de runtime do custo de login | **confirmada**: ~150 ms mesmo para conta inexistente |

O rate limit e o tempo constante de login foram verificados executando a API real via
`app.inject()`, não apenas por leitura de código. Ver [Como reverificar](#como-reverificar).

**Não executado nesta máquina:** `pnpm docker:production:validate` e `pnpm test:e2e` exigem
Docker Compose, ausente neste computador. Precisam rodar no host Coolify antes do merge.

---

## ✅ Aplicado nesta branch

### Item 1 — Porta 1883 em texto puro exposta por padrão · CRÍTICO

`docker-compose.production.yml` publicava `${MQTT_TCP_BIND_ADDRESS:-0.0.0.0}:1883`. O default
expunha MQTT sem TLS à internet, com credenciais em claro.

**Feito:** default alterado para `127.0.0.1`, com comentário registrando que o Docker publica
portas pela chain `DOCKER` do iptables, **avaliada antes do UFW** — uma regra `ufw deny 1883`
não protege uma porta publicada em `0.0.0.0`.

> ⚠️ **A correção do arquivo não conserta um container já em execução.** Enquanto não houver
> redeploy, a exposição continua. Confirmar na VPS: veja [Ações de operação](#ações-de-operação-somente-vocês).

### Item 2 — DoS trivial por ausência de rate limiting · CRÍTICO

A API não tinha nenhum limite global. `/api/auth/login` executa scrypt (`N=16384`, 64 MB,
~100 ms de CPU) e a saturação medida do serviço inteiro é ~15 req/s.

**Feito:** `@fastify/rate-limit` adicionado e registrado **antes** de qualquer rota.

- Global: 300 req/min por cliente, `allowList` para `127.0.0.1`/`::1` (healthchecks).
- `POST /api/auth/login`: 10/min.
- `GET /api/export/telemetry.csv`: 5/min.

**Duas armadilhas encontradas e corrigidas durante a implementação** — ambas fariam o limite
existir no código sem funcionar em produção:

1. `app.register()` sem `await` deixava o hook global sem alcançar as rotas registradas de
   forma síncrona logo depois. **`createApp` passou a ser `async`** e o registro é aguardado.
   Todos os chamadores receberam `await` (`apps/api/src/index.ts`, `tests/flow.integration.test.ts`).
2. O `setErrorHandler` customizado convertia o `429` lançado pelo plugin em `500`. O handler
   agora respeita `statusCode` de erros de plugin (429 explícito, demais 4xx preservados).

### Item 3 — `trustProxy` ausente · ALTO

Sem isso, `request.ip` é o IP do proxy do Coolify para todo mundo, e qualquer limite por
cliente vira um balde único e global.

**Feito:** `trustProxy: (_address, hop) => hop === 0` — confia exatamente em um salto.
Deliberadamente **não** `true`, que permitiria forjar `X-Forwarded-For`.

### Item 4 — Usuário comum podia falsificar telemetria · ALTO

`POST /api/devices/:id/tags` exigia apenas `requireDevice`. Com `ON CONFLICT DO UPDATE`, um
usuário de perfil `user` (espectador) podia alterar `scale_multiplier` de uma tag existente e
mudar silenciosamente todos os valores futuros daquele sensor — adulteração de registro.

**Feito:** `requireMaster` adicionado à rota.

### Item 5 — Ausência total de cabeçalhos de segurança · ALTO

**Feito:** `apps/web/next.config.ts` passou a emitir CSP, HSTS, `X-Frame-Options: DENY`,
`X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy` e `Permissions-Policy`.

Decisões registradas no próprio arquivo:
- `img-src` permite `https:` para não quebrar `tenant_branding.logo_url` apontando para CDN do cliente.
- `frame-ancestors 'none'` bloqueia clickjacking das telas administrativas.
- `'unsafe-eval'` **não** foi concedido.

> ⚠️ **CSP não foi validada em navegador** — não há browser disponível neste ambiente.
> Ver [Ações de operação](#ações-de-operação-somente-vocês) antes do merge.

### Item 6 — Enumeração de usuários por status e por tempo · ALTO

Havia dois oráculos: `403 'User inactive'` versus `401 'Invalid email or password'`, e a
diferença de tempo (scrypt só rodava se a conta existisse: ~2 ms contra ~100 ms).

**Feito:** resposta `401` idêntica para conta inexistente, senha errada e conta inativa. Um
hash decoy (derivado de bytes aleatórios em memória, cuja senha ninguém possui) garante que
o scrypt rode sempre. Medido: ~150 ms independentemente da conta existir.

> Efeito colateral aceito: um usuário legitimamente desativado vê "e-mail ou senha inválidos".
> A comunicação de desativação passa a ser responsabilidade do operador.

### Item 7 — Throttle de login sem limite de memória e sem escopo de conta · ALTO

O `Map` crescia sem limite (spray de e-mails únicos → exaustão de memória) e a chave era
apenas `ip:email`, então um ataque distribuído contra uma conta ignorava o mecanismo.

**Feito (mitigação parcial):**
- `pruneAttempts` com teto de 20.000 entradas: remove expiradas, depois as mais antigas.
- Duas chaves independentes: `origin:<ip>:<email>` (8 tentativas) e `account:<email>` (20).

> **Continua pendente:** ainda é memória de processo. Ver [item 7b](#item-7b--lockout-persistente-no-banco--alto).

### Item 9 — CSRF em camada única · MÉDIO

`app/api/[...path]/route.ts` validava origem, mas `/api/auth/login`, `/logout` e
`/change-password` não — dependiam apenas de `SameSite=Strict`.

**Feito:** `originAllowed` extraída para `apps/web/lib/origin.ts` e aplicada às três rotas.
`[...path]/route.ts` passou a importar a função em vez de manter cópia local.

> Comportamento preservado de propósito: requisição **sem** header `Origin` é aceita, porque
> ferramentas não-navegador (`scripts/e2e.ts`, `scripts/load-test.mjs`) não o enviam.
> Ver [item 9b](#item-9b--token-csrf-explícito--médio).

### Item 11 — TLS 1.3 desabilitado no broker · MÉDIO

`tls_version tlsv1.2` fixava a versão e impedia TLS 1.3.

**Feito:** diretiva removida de `mosquitto-tls.conf` e do `.example`. Sem o pin, o Mosquitto
negocia a versão mais alta disponível e continua recusando abaixo de TLS 1.2.

### Item 10 — Garantia explícita de autenticação no listener 8883 · MÉDIO

`allow_anonymous false`, `password_file` e `acl_file` aparecem antes do bloco `listener 8883`.
No Mosquitto 2.x são globais quando `per_listener_settings` é `false` (o default), então valem
para os dois listeners.

**Feito:** `per_listener_settings false` declarado explicitamente no topo, com comentário
avisando que mudá-lo para `true` sem repetir as diretivas em cada bloco deixaria o 8883 anônimo.

> ⚠️ **Isso torna a garantia explícita, mas não substitui o teste.** Ver [Ações de operação](#ações-de-operação-somente-vocês).

---

## ⏳ Pendências

Ordenadas por prioridade. Cada item traz onde mexer e o critério de pronto.

### Item 12 — Senha MQTT do equipamento em texto puro · CRÍTICO

**Onde:** `apps/api/src/app.ts` (`POST /api/devices`, `mqtt_password`),
`apps/web/app/devices/page.tsx:169`, coluna `devices.mqtt_password` (migration 005).

**Problema:** a senha é gravada em claro e devolvida pela API a qualquer momento, não só no
provisionamento. Uma conta master comprometida ou um dump do Supabase entrega a credencial de
broker de **todos** os equipamentos, permitindo publicar telemetria falsa.

**Não foi corrigido nesta branch** porque exige migration + mudança de UX, e a branch se
propôs a não alterar schema para não colidir com o outro agente.

**Plano:** *show once*. Exibir a senha apenas na resposta de criação; parar de devolvê-la em
`GET /api/devices`. Para recuperação, usar "regenerar credencial", que já é possível chamando
`provisionMqttRequest('upsert', ...)`. Se a persistência for mesmo necessária, cifrar com
AES-256-GCM usando chave de ambiente. **Esforço: ~2 h.**

### Item 7b — Lockout persistente no banco · ALTO

**Onde:** `apps/api/src/auth.ts` (bloco `loginAttempts`).

Ainda é memória de processo: zera a cada redeploy e não é compartilhado entre réplicas.
Obrigatório antes de rodar mais de uma instância de API.

**Plano:** colunas `failed_attempts` e `locked_until` em `app_users`, ou Redis. Incluir
desbloqueio administrativo — o limite por conta introduzido no item 7 permite que um atacante
bloqueie deliberadamente um master (DoS de disponibilidade), e hoje só resta esperar 15 min.
**Esforço: ~2 h + migration.**

### Item 16 — Trilha de auditoria inexistente · ALTO

Não há registro de quem criou, alterou ou removeu usuário, equipamento ou tag. Numa
investigação pós-incidente é impossível responder "quem fez isso". `app_sessions` guarda IP e
user-agent, mas não ações.

**Plano:** tabela `audit_log` (ator, papel, ação, tipo de alvo, id do alvo, IP, timestamp,
diff resumido) preenchida em todas as rotas de mutação de `app.ts` e `auth.ts`.
**Esforço: ~4 h.** Toca muitas rotas — coordenar com o outro agente.

### Item 5b — CSP sem `'unsafe-inline'` em script-src · MÉDIO

O Next injeta um script inline de bootstrap por página, então `'unsafe-inline'` continua
necessário. Removê-lo exige nonce por requisição emitido pelo middleware (`apps/web/proxy.ts`,
que já existe) e propagado para o CSP. **Esforço: ~2 h.**

### Item 9b — Token CSRF explícito · MÉDIO

Com um token, `originAllowed` poderia negar por padrão quando não houver header `Origin`, em
vez de aceitar. **Esforço: ~2 h.**

### Item 13 — RLS no Supabase · MÉDIO

Os grants de `anon`/`authenticated` já foram revogados na migration 002, o que mitiga bastante.
RLS seria a segunda barreira caso a connection string vaze.

**Plano:** propagar o tenant da sessão via `SET LOCAL app.tenant_id` no pool e escrever policy
por tabela. **Esforço: 1–2 dias, com risco real de quebrar consultas existentes** — fazer
isolado, com a suíte de integração como rede de proteção.

### Item 14 — Expiração de sessão por inatividade · MÉDIO

Sessões duram 12 h fixas, sem renovação por atividade e sem limite de sessões simultâneas por
conta. `app_sessions.last_seen_at` já é atualizado e serve de base. **Esforço: ~1 h.**

### Item 15 — `mosquitto_passwd -b` expõe senha em `/proc` · BAIXO

`infrastructure/mosquitto/provision-watcher.sh:26` passa a senha por linha de comando, visível
em `/proc/<pid>/cmdline` durante a execução. Container de propósito único, risco baixo.
**Plano:** usar `-c`/stdin se a versão suportar. **Esforço: ~30 min.**

### Item 17 — Credencial estática `a7-001` em produção · MÉDIO

**Mantida deliberadamente.** Está em `infrastructure/mosquitto/config/acl`, `init.sh`,
`docker-compose.production.yml`, `.env.example`, `infrastructure/coolify/deployment.json` e
`scripts/validate-production.mjs`.

Removê-la agora **derrubaria o primeiro teste de campo da Haiwell A7**, que é o próximo marco
do projeto. O bloco na ACL foi marcado com `SECURITY-DEBT`.

**Remover assim que a A7 for provisionada pelo provisionador de runtime.** Uma credencial
estática compartilhada não pode ser revogada por equipamento. **Esforço: ~1 h.**

### Item 18 — Sem `pnpm audit` no CI e sem Dependabot · MÉDIO

Nenhuma verificação automática de vulnerabilidade em dependências. **Esforço: ~30 min.**

### Item 19 — Pentest externo · dependência de terceiro

Só faz sentido depois dos itens acima. Semanas de calendário e custo. Compradores industriais
costumam exigir.

---

## Ações de operação (somente vocês)

Nenhuma pode ser feita a partir deste repositório.

### 1. Confirmar a exposição da porta 1883 — faça hoje

É o único item que pode já estar sendo explorado. A correção no arquivo só vale após redeploy.

```bash
# De fora da VPS:
nmap -Pn -p 1883,8883 mqtt.everlenz.com.br

# Na VPS:
ss -tlnp | grep -E '1883|8883'
sudo iptables -t nat -L DOCKER -n | grep 1883
```

Se 1883 responder de fora: definir `MQTT_TCP_BIND_ADDRESS=127.0.0.1` nas variáveis do Coolify
e redeployar. Idealmente, remover o mapeamento de 1883 do compose — o ingestor usa
`mosquitto:1883` pela rede interna do Docker e não precisa da porta publicada.

### 2. Testar autenticação anônima no 8883 (item 10)

```bash
mosquitto_sub -h mqtt.everlenz.com.br -p 8883 --capath /etc/ssl/certs -t '#' -W 5
```

Qualquer resultado que **não** seja erro de autenticação é CRÍTICO — escalar junto ao item 1.

### 3. Validar a CSP em navegador antes do merge (item 5)

Subir a branch em staging, abrir o painel, o modo TV, o MQTT Inspector e a tela de usuários, e
conferir o console por bloqueios de CSP. Atenção especial a `recharts` e ao logo de white label.

### 4. Rodar o que exige Docker

```bash
pnpm docker:production:validate
pnpm test:e2e
```

### 5. Rotacionar credenciais se a 1883 estiver exposta

Se a porta estava aberta, considere todas as senhas MQTT comprometidas: rotacionar
`MQTT_PASSWORD`, `MQTT_SIMULATOR_PASSWORD`, `MQTT_DEVICE_A7_PASSWORD` e as credenciais de
equipamento provisionadas.

---

## Coordenação entre agentes

Esta branch é **exclusivamente de segurança**. O outro agente trabalha em produto e ingestão.

### Arquivos alterados aqui — conferir antes de editar

| Arquivo | Natureza da mudança |
| --- | --- |
| `apps/api/src/app.ts` | `createApp` virou **async**; rate limit; `trustProxy`; `setErrorHandler`; `requireMaster` em tags; assinatura da rota de export CSV |
| `apps/api/src/auth.ts` | decoy hash; throttle com duas chaves e poda; resposta de login unificada; assinatura da rota de login |
| `apps/api/src/index.ts` | `await createApp()` |
| `apps/api/package.json` | `@fastify/rate-limit` |
| `apps/web/next.config.ts` | reescrito com cabeçalhos de segurança |
| `apps/web/lib/origin.ts` | **novo** |
| `apps/web/app/api/[...path]/route.ts` | `originAllowed` movida para `lib/origin.ts` |
| `apps/web/app/api/auth/{login,logout,change-password}/route.ts` | checagem de origem |
| `docker-compose.production.yml` | default de bind da 1883 |
| `infrastructure/mosquitto/config/{acl,mosquitto-tls.conf,mosquitto-tls.conf.example}` | `per_listener_settings`, TLS, marcação de dívida |
| `tests/flow.integration.test.ts` | `await createApp(...)` em 7 pontos |

### A mudança que mais pode quebrar o trabalho do outro agente

**`createApp` agora é `async`.** Qualquer código novo que a chame precisa de `await`. Foi a
única forma de garantir que o hook do rate limit alcance as rotas — verificado em runtime.

### Não foi tocado

Schema e migrations, pipeline de ingestão, adapters, painéis/widgets, simulador. O item 12
(senha MQTT) e o item 16 (auditoria) exigem migration e ficaram de fora justamente para não
colidir com migrations em andamento. **Alinhar o número da próxima migration antes de criar.**

---

## Como reverificar

```bash
pnpm lint
pnpm test
pnpm test:integration
IIOT_LOAD_ENV=false pnpm build
```

Para reproduzir a verificação de runtime do rate limit e do tempo constante de login, crie um
script que instancie a API com um `Database` falso e dispare 13 logins pela mesma origem:

```ts
const app = await createApp(fakeDb, { tenantId: '…', operatorRaw: false, authRequired: true });
await app.ready();
// 13 × app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', … })
// Esperado: dez 401 seguidos de 429, e tempo por requisição estável mesmo sem a conta existir.
```

Execute com `NODE_ENV=production`, senão o rate limit não é registrado (ele é desativado em
`test` de propósito, para não tornar a suíte instável).
