# Segurança — estado, correções aplicadas e pendências

Documento de rastreamento da revisão de segurança de **9 de setembro de 2026**, feita sobre
o commit `03fc5d8`. Serve como fonte única para continuar o trabalho.

Numeração estável: os itens mantêm o número original da revisão mesmo depois de resolvidos.
Comentários no código referenciam esses números como `SECURITY.md item N`.

> **Escopo da branch `security/hardening-sprint-0`:** apenas segurança. Nenhuma mudança de
> produto, painel ou lógica de ingestão. Há **uma migration** (`009`) e **uma mudança de
> comportamento visível** (senha MQTT deixou de ser recuperável).
> Ver [Coordenação entre agentes](#coordenação-entre-agentes).

---

## Validação executada

| Verificação                                                 | Resultado                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm lint` (ESLint + TypeScript do monorepo e do frontend) | aprovado                                                             |
| `pnpm format:check`                                         | aprovado                                                             |
| `pnpm test`                                                 | **51 testes unitários aprovados**                                    |
| `pnpm test:integration`                                     | **18 testes aprovados** (PGlite), incluindo o novo caso de segurança |
| `pnpm build` (`IIOT_LOAD_ENV=false`)                        | aprovado, incluindo Next standalone                                  |
| `pnpm audit --audit-level high --prod`                      | sem vulnerabilidades conhecidas                                      |
| Runtime: rate limit                                         | **confirmado**: 10 requisições aceitas, seguintes com `429`          |
| Runtime: custo constante de login                           | **confirmado**: ~150 ms mesmo para conta inexistente                 |

O teste de integração `never stores broker passwords, records an audit trail and locks out
brute force` cobre quatro garantias de uma vez: a coluna `mqtt_password` não existe mais e
nenhuma rota a devolve; a rotação gera segredo diferente; `audit_log` registra criação e
rotação com o autor correto; um perfil `user` recebe `403` ao tentar gravar tag; e o lockout
persistente resiste a tentativas vindas de endereços diferentes, que é justamente o que
derrota o throttle em memória.

**Não executado nesta máquina:** `pnpm docker:production:validate` e `pnpm test:e2e` exigem
Docker Compose, ausente neste computador. Precisam rodar no host antes do merge.

---

## ✅ Aplicado

### Item 1 — Porta 1883 em texto puro exposta por padrão · CRÍTICO

`docker-compose.production.yml` publicava `${MQTT_TCP_BIND_ADDRESS:-0.0.0.0}:1883`, expondo
MQTT sem TLS à internet com credenciais em claro.

**Feito:** default alterado para `127.0.0.1`, com o motivo registrado no arquivo — o Docker
publica portas pela chain `DOCKER` do iptables, **avaliada antes do UFW**, então uma regra
`ufw deny 1883` não protege uma porta publicada em `0.0.0.0`.

> ⚠️ A correção do arquivo não conserta um container em execução. Ver
> [Ações de operação](#ações-de-operação-somente-vocês).

### Item 2 — DoS trivial por ausência de rate limiting · CRÍTICO

A API não tinha limite algum, enquanto `/api/auth/login` custa ~100 ms de scrypt e o serviço
satura perto de 15 req/s.

**Feito:** `@fastify/rate-limit` registrado **antes** de qualquer rota — 300/min global
(`allowList` de loopback para healthchecks), 10/min no login, 5/min no export CSV.

**Duas armadilhas encontradas em runtime**, ambas deixariam o limite presente no código e
inerte em produção:

1. `app.register()` sem `await` deixava o hook global fora do alcance das rotas registradas
   de forma síncrona depois. **`createApp` passou a ser `async`.**
2. O `setErrorHandler` convertia o `429` do plugin em `500`. Agora respeita o `statusCode`
   sinalizado por plugins.

### Item 3 — `trustProxy` ausente · ALTO

**Feito:** `trustProxy: (_address, hop) => hop === 0`. Confia em exatamente um salto e
deliberadamente **não** em `true`, que permitiria forjar `X-Forwarded-For`.

### Item 4 — Usuário comum podia falsificar telemetria · ALTO

`POST /api/devices/:id/tags` exigia apenas `requireDevice`. Com `ON CONFLICT DO UPDATE`, um
perfil `user` podia alterar `scale_multiplier` e mudar silenciosamente todos os valores
futuros do sensor. **Feito:** `requireMaster` na rota. Coberto por teste.

### Item 5 — Ausência de cabeçalhos de segurança · ALTO

**Feito:** CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
`Cross-Origin-Opener-Policy` e `Permissions-Policy` em `apps/web/next.config.ts`.
`img-src` permite `https:` para não quebrar logo de white label. `'unsafe-eval'` não foi
concedido.

> ⚠️ **CSP não foi validada em navegador.** Ver [Ações de operação](#ações-de-operação-somente-vocês).

### Item 6 — Enumeração de usuários · ALTO

Dois oráculos: `403 'User inactive'` contra `401`, e a diferença de tempo (scrypt só rodava
para conta existente).

**Feito:** `401` idêntico para conta inexistente, senha errada, conta inativa **e conta
bloqueada**. Um hash decoy garante custo constante. Medido: ~150 ms em qualquer caso.

### Item 7 — Throttle em memória sem limite e sem escopo de conta · ALTO

**Feito:** `pruneAttempts` com teto de 20.000 entradas, e duas chaves independentes —
`origin:<ip>:<email>` (8 tentativas) e `account:<email>` (20).

### Item 7b — Lockout persistente no banco · ALTO

**Feito:** `app_users.failed_attempts` e `locked_until` (migration 009). Dez falhas bloqueiam
por 15 minutos, e o bloqueio sobrevive a redeploy e vale entre réplicas. O throttle em
memória continua como primeira camada barata, cobrindo inclusive e-mails sem linha no banco.

Como um bloqueio por conta pode ser provocado de propósito por um atacante, o reset de senha
por um master **também limpa `failed_attempts` e `locked_until`** — é a saída administrativa.
Coberto por teste, inclusive o caminho de desbloqueio.

### Item 9 — CSRF em camada única · MÉDIO

**Feito:** `originAllowed` extraída para `apps/web/lib/origin.ts` e aplicada a
`/api/auth/login`, `/logout` e `/change-password`, que antes dependiam só de
`SameSite=Strict`.

> Requisição **sem** header `Origin` continua aceita de propósito: ferramentas não-navegador
> (`scripts/e2e.ts`, `scripts/load-test.mjs`) não o enviam. Ver [item 9b](#item-9b--token-csrf-explícito--médio).

### Item 10 — Autenticação no listener 8883 · MÉDIO

**Feito:** `per_listener_settings false` declarado explicitamente, com comentário avisando
que mudá-lo para `true` sem repetir `password_file`/`acl_file`/`allow_anonymous` em cada
bloco deixaria o 8883 anônimo.

> ⚠️ Torna a garantia explícita, mas **não substitui o teste**. Ver [Ações de operação](#ações-de-operação-somente-vocês).

### Item 11 — TLS 1.3 desabilitado no broker · MÉDIO

**Feito:** `tls_version tlsv1.2` removido. Sem o pin, o Mosquitto negocia a versão mais alta
e continua recusando abaixo de TLS 1.2.

### Item 12 — Senha MQTT do equipamento em texto puro · CRÍTICO

A senha era gravada em claro em `devices.mqtt_password` e devolvida pela API em **toda**
leitura de dispositivo, via `SELECT d.*`. Uma conta master comprometida ou um dump do banco
entregava a credencial de broker de todos os equipamentos, permanentemente.

**Feito (migration 009 + API + interface):**

- Coluna `mqtt_password` **removida**. Passou a existir `mqtt_credential_rotated_at`, que
  guarda apenas o instante da última rotação.
- A senha é gerada, entregue ao provisionador do broker e devolvida **uma única vez**, na
  resposta da criação. Nunca é persistida.
- Nova rota `POST /api/devices/:id/mqtt-credential` (master) gera e devolve uma nova senha,
  uma vez. É o único caminho de recuperação.
- A interface exibe a senha apenas na sessão em que foi gerada, com aviso explícito, e
  oferece **"Gerar nova senha MQTT"** no lugar da consulta anterior.
- Comentário fixado sobre o `deviceSelect`: `d.*` chega ao navegador, então nenhuma coluna
  sensível pode ser adicionada a `devices`.

> ⚠️ **A migration destrói as senhas existentes.** Todo equipamento já cadastrado precisa de
> rotação. Ver [Ações de operação](#ações-de-operação-somente-vocês).

### Item 14 — Expiração de sessão por inatividade · MÉDIO

**Feito:** além do teto absoluto de 12 h, uma sessão morre após **4 h** sem atividade, e a
linha é removida na primeira tentativa de uso. O limite fica acima do intervalo de polling do
painel, então um operador com a tela aberta não é desconectado no meio do turno.

### Item 16 — Trilha de auditoria · ALTO

**Feito:** tabela `audit_log` (migration 009) e helper `apps/api/src/audit.ts`.

Registra ator, papel, ação, tipo e id do alvo, resumo em JSON, IP e user-agent. Instrumentado
em: criação/alteração/arquivamento de dispositivo, rotação de credencial MQTT, upsert de tag
(com a escala, porque alterá-la reinterpreta o histórico), criação de site, e
criação/alteração/remoção/reset de senha de usuário.

Duas decisões registradas no código:

- **Fail-closed:** um erro ao gravar auditoria **não** é engolido. A mutação falha. A causa
  realista é a migration 009 não aplicada, e falhar alto torna isso impossível de ignorar.
- Quando o chamador já tem transação, a linha de auditoria entra nela — a mudança e seu
  registro commitam ou revertem juntos.
- `actor_id` é resolvido por subconsulta, para que o principal sintético usado quando a
  autenticação está desligada (testes) grave `NULL` em vez de violar a FK.

### Item 18 — Verificação de dependências no CI · MÉDIO

**Feito:** `.github/workflows/validate.yml` roda `pnpm audit --audit-level high --prod`
(bloqueante) e um `pnpm audit` completo informativo. `.github/dependabot.yml` acompanha npm,
GitHub Actions e as duas imagens Docker, com agrupamento para não abrir dezenas de PRs.
Hoje: **nenhuma vulnerabilidade conhecida**.

---

## ⏳ Pendências

### Item 13 — RLS no Supabase · MÉDIO

Os grants de `anon`/`authenticated` já foram revogados na migration 002, o que mitiga
bastante. RLS seria a segunda barreira caso a connection string vaze.

**Não foi feito de propósito.** Exige propagar o tenant da sessão via `SET LOCAL` no pool,
escrever policy por tabela e lidar com o fato de que o dono da tabela ignora RLS sem
`FORCE ROW LEVEL SECURITY`. É **1–2 dias com risco real de quebrar consultas existentes** —
fazer isolado, com a suíte de integração como rede de proteção. Feito às pressas seria pior
que não feito.

### Item 5b — CSP sem `'unsafe-inline'` em script-src · MÉDIO

O Next injeta um script inline de bootstrap por página. Removê-lo exige nonce por requisição
emitido pelo middleware (`apps/web/proxy.ts`, que já existe). **Esforço: ~2 h.**

### Item 9b — Token CSRF explícito · MÉDIO

Com token, `originAllowed` poderia negar por padrão quando não houver `Origin`, em vez de
aceitar. **Esforço: ~2 h.**

### Item 17 — Credencial estática `a7-001` · MÉDIO

**Mantida deliberadamente.** Presente em `infrastructure/mosquitto/config/acl`, `init.sh`,
`docker-compose.production.yml`, `.env.example`, `infrastructure/coolify/deployment.json` e
`scripts/validate-production.mjs`.

Removê-la agora derrubaria o **primeiro teste de campo da Haiwell A7**, que é o próximo marco
do projeto. O bloco na ACL está marcado com `SECURITY-DEBT`. Remover assim que a A7 for
provisionada pelo provisionador de runtime — uma credencial estática compartilhada não pode
ser revogada por equipamento. **Esforço: ~1 h.**

### Item 15 — `mosquitto_passwd -b` expõe senha em `/proc` · BAIXO

`infrastructure/mosquitto/provision-watcher.sh` passa a senha por linha de comando, visível
em `/proc/<pid>/cmdline` durante a execução. Container de propósito único, risco baixo.
**Esforço: ~30 min.**

### Item 19 — Pentest externo · dependência de terceiro

Só faz sentido depois do item 13. Semanas de calendário e custo. Compradores industriais
costumam exigir.

### Item 20 — Alertas de segurança · bloqueado

Notificar bloqueio de conta, login de IP novo ou falha de provisionamento **depende de uma
infraestrutura de notificação que não existe na plataforma**. Pertence ao roadmap de alarmes,
não ao de segurança. A `audit_log` já fornece a fonte de dados.

---

## Ações de operação (somente vocês)

### 1. Confirmar a exposição da porta 1883 — faça primeiro

É o único item que pode já estar sendo explorado. A correção no arquivo só vale após redeploy.

```bash
# De fora da VPS:
nmap -Pn -p 1883,8883 mqtt.everlenz.com.br

# Na VPS:
ss -tlnp | grep -E '1883|8883'
sudo iptables -t nat -L DOCKER -n | grep 1883
```

Se 1883 responder de fora: definir `MQTT_TCP_BIND_ADDRESS=127.0.0.1` no Coolify e redeployar.
Idealmente, remover o mapeamento de 1883 do compose — o ingestor usa `mosquitto:1883` pela
rede interna e não precisa da porta publicada. **Se estava aberta, trate todas as senhas MQTT
como comprometidas e rotacione.**

### 2. Testar autenticação anônima no 8883 (item 10)

```bash
mosquitto_sub -h mqtt.everlenz.com.br -p 8883 --capath /etc/ssl/certs -t '#' -W 5
```

Qualquer resultado que **não** seja erro de autenticação é CRÍTICO.

### 3. Aplicar a migration 009 e rotacionar as credenciais existentes

```bash
pnpm db:status
pnpm db:migrate
pnpm db:status
```

A migration **apaga as senhas MQTT armazenadas**. Depois dela, cada equipamento já cadastrado
precisa de uma nova senha: abrir o equipamento na interface, usar **"Gerar nova senha MQTT"**
e configurar a IHM com o valor exibido. Enquanto isso não for feito, o equipamento continua
publicando normalmente (a senha antiga segue válida no broker); o que se perdeu foi apenas a
capacidade de consultá-la.

### 4. Validar a CSP em navegador antes do merge (item 5)

Subir a branch em staging e abrir painel, modo TV, MQTT Inspector e tela de usuários,
conferindo o console por bloqueios. Atenção a `recharts` e ao logo de white label.

### 5. Rodar o que exige Docker

```bash
pnpm docker:production:validate
pnpm test:e2e
```

---

## Coordenação entre agentes

Esta branch é **exclusivamente de segurança**. O outro agente trabalha em produto e ingestão.

### ⚠️ Três mudanças que podem quebrar trabalho em andamento

1. **`createApp` agora é `async`.** Todo chamador precisa de `await`. Foi a única forma de
   garantir que o hook do rate limit alcance as rotas — verificado em runtime, não por
   leitura. Atualizados: `apps/api/src/index.ts` e 7 pontos em `tests/flow.integration.test.ts`.
2. **A migration `009_security_hardening.sql` existe.** A próxima migration é a **010** —
   confirmar antes de criar, para não colidir.
3. **`devices.mqtt_password` não existe mais.** Qualquer código que a leia quebra. O tipo
   `Device` em `apps/web/components/data.ts` perdeu o campo e ganhou
   `mqtt_credential_rotated_at`.

### Arquivos alterados — conferir antes de editar

| Arquivo                                                                               | Natureza da mudança                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/app.ts`                                                                 | `createApp` async; rate limit; `trustProxy`; `setErrorHandler`; `requireMaster` em tags; rota de rotação de credencial; auditoria; assinatura da rota de export CSV |
| `apps/api/src/auth.ts`                                                                | decoy hash; throttle com duas chaves e poda; lockout persistente; inatividade de sessão; login unificado; auditoria nas rotas de usuário                            |
| `apps/api/src/audit.ts`                                                               | **novo** — helper de auditoria                                                                                                                                      |
| `apps/api/src/index.ts`                                                               | `await createApp()`                                                                                                                                                 |
| `apps/api/package.json`                                                               | `@fastify/rate-limit`                                                                                                                                               |
| `packages/database/migrations/009_security_hardening.sql`                             | **novo**                                                                                                                                                            |
| `apps/web/next.config.ts`                                                             | reescrito com cabeçalhos de segurança                                                                                                                               |
| `apps/web/lib/origin.ts`                                                              | **novo**                                                                                                                                                            |
| `apps/web/components/data.ts`                                                         | tipo `Device`                                                                                                                                                       |
| `apps/web/app/devices/page.tsx`                                                       | rotação de credencial, senha exibida uma vez                                                                                                                        |
| `apps/web/app/api/[...path]/route.ts`                                                 | `originAllowed` movida; allowlist inclui `mqtt-credential`                                                                                                          |
| `apps/web/app/api/auth/{login,logout,change-password}/route.ts`                       | checagem de origem                                                                                                                                                  |
| `docker-compose.production.yml`                                                       | default de bind da 1883                                                                                                                                             |
| `infrastructure/mosquitto/config/{acl,mosquitto-tls.conf,mosquitto-tls.conf.example}` | `per_listener_settings`, TLS, dívida marcada                                                                                                                        |
| `.github/workflows/validate.yml`, `.github/dependabot.yml`                            | auditoria de dependências                                                                                                                                           |
| `tests/flow.integration.test.ts`                                                      | `await createApp(...)` e novo caso de segurança                                                                                                                     |

### Não foi tocado

Pipeline de ingestão, adapters, painéis, widgets, simulador e o schema de telemetria.

---

## Como reverificar

```bash
pnpm lint
pnpm test
pnpm test:integration
pnpm audit --audit-level high --prod
IIOT_LOAD_ENV=false pnpm build
```

Para reproduzir a verificação de runtime do rate limit e do tempo constante de login, crie um
script que instancie a API com um `Database` falso e dispare 13 logins pela mesma origem:

```ts
const app = await createApp(fakeDb, { tenantId: '…', operatorRaw: false, authRequired: true });
await app.ready();
// 13 × app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', … })
// Esperado: dez 401 seguidos de 429, com tempo estável mesmo sem a conta existir.
```

Execute com `NODE_ENV=production`: em `test` o rate limit não é registrado, de propósito,
para não tornar a suíte instável.
