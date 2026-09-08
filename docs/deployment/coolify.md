# Deployment Coolify + Supabase

## Manifesto e escopo

Usar o repositório existente, diretório raiz `/`, build pack Docker Compose e arquivo **docker-compose.production.yml**. Não combinar esse arquivo com `docker-compose.yml`, que é exclusivamente laboratório. Nenhum deployment remoto foi executado nesta etapa.

`infrastructure/coolify/deployment.json` fornece um contrato legível por agente com serviços, portas, variáveis e pré-condições. É um manifesto interno de preparação, não um payload a enviar cegamente à API Coolify; o agente deve conferir a versão/API da instância antes de criar o recurso. O broker escreve em stdout e no volume de logs; monitorar espaço e definir rotação operacional antes de uso contínuo.

| Serviço   | Build target                        | Rede/porta                                       | Persistência                                                              |
| --------- | ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| mosquitto | infrastructure/mosquitto/Dockerfile | Host TCP 1883 e TLS 8883                         | mqtt-config, mqtt-auth, mqtt-data, mqtt-log; certificados montados da VPS |
| ingestor  | Dockerfile:ingestor                 | MQTT interno mosquitto:1883; health interno 3002 | Dados no Supabase; nenhuma porta host                                     |
| api       | Dockerfile:api                      | HTTP interno 3001                                | Dados no Supabase; sem banco/container local                              |
| web       | Dockerfile:web                      | HTTP interno 3000                                | Next standalone; sem secrets de banco                                     |

Os processos Node usam JavaScript compilado, usuário não root e comando exec `node`, com `init: true`, restart e SIGTERM. As imagens API/ingestor recebem somente artefatos e dependências de produção via pnpm deploy; web usa Next standalone. Não há `tsx`, seed ou migrations no startup de produção. Um Dockerfile multi-stage central evita duplicar configuração de workspace.

O Coolify conecta o proxy aos serviços com domínio; `expose` indica a porta interna e não publica no host. Configure domínio web com destino à porta **3000**, e API opcional com destino à **3001**. O browser usa `/api` no próprio domínio web; o Next encaminha a `http://api:3001`. A API não conecta diretamente ao broker: consulta estado por HTTP no ingestor. [Compose no Coolify](https://coolify.io/docs/knowledge-base/docker/compose).

`IIOT_WEB_DOMAIN` e `IIOT_API_DOMAIN` são entradas de configuração para o operador/agente Coolify; escrevê-las em ENV **não cria** rotas/DNS. Configurar explicitamente os domínios no recurso e a porta destino. `MQTT_PUBLIC_HOST` é o DNS usado por equipamentos; `MQTT_INTERNAL_HOST=mosquitto` é somente rede Docker. O host público não é injetado no ingestor. [Domínios e portas internas](https://coolify.io/docs/knowledge-base/domains).

## Preparação de rede e secrets

1. Selecionar projeto, ambiente, servidor/destination e repositório/branch no Coolify existente. Não instalar outro Coolify nem criar outro Supabase.
2. Configurar DNS dos hosts HTTP e MQTT para a VPS. MQTT deve resolver diretamente ao servidor, sem proxy HTTP/CDN que não suporte MQTT TCP.
3. Configurar firewall da VPS/provedor **antes de iniciar o broker**. 8883 aceita somente as origens acordadas; 1883 deve ficar restrita à origem da A7/laboratório ou VPN. Considerar regras efetivas de publicação Docker/DOCKER-USER, não apenas UFW. Se não houver origem controlada, alterar `MQTT_TCP_BIND_ADDRESS=127.0.0.1` e usar túnel/VPN.
4. Disponibilizar em `/data/coolify/certificates/mqtt.everlenz.com.br` os arquivos `fullchain.pem` e `privkey.pem`, legíveis pelo UID 1883 e protegidos de outros usuários. O caminho é fixo porque o parser do Coolify rejeita substituição de variáveis em origens de bind mounts. `sync-traefik-cert.py` extrai e renova o certificado emitido pelo Traefik. O bind usa `create_host_path:false`; caminhos ou certificados ausentes impedem o startup.
5. Preencher secrets de runtime conforme a tabela. Não marcar DATABASE_URL ou senhas como build variables; não usar `.env` versionado. Não compartilhar saída expandida de `docker compose config`; preferir `--quiet`.

| Configuração                                      | Serviço                          | Obrigatória agora?                                             |
| ------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| DATABASE_URL                                      | api, ingestor, operação de banco | Sim, Direct ou Session; senha URL-encoded                      |
| DATABASE_SSL_CA_PEM                               | mesmos                           | Só se cadeia exigir CA adicional                               |
| DATABASE_POOL_MAX                                 | api/ingestor                     | Padrão 5 por processo                                          |
| MQTT_USERNAME / MQTT_PASSWORD                     | broker/ingestor                  | Nome `ingestor`, senha própria forte                           |
| MQTT_SIMULATOR_USERNAME / MQTT_SIMULATOR_PASSWORD | broker                           | Nome `simulator`, senha separada; nenhum simulador inicia      |
| Certificados MQTT                                 | broker                           | Caminho fixo `/data/coolify/certificates/mqtt.everlenz.com.br` |
| DEV_TENANT_ID                                     | api                              | UUID de tenant cadastrado; não é autenticação                  |
| MQTT_DISCOVERY_MODE                               | ingestor                         | false, exceto janela controlada de captura                     |
| OPERATOR_RAW_ACCESS                               | api                              | false; true só para operador protegido na descoberta           |
| MQTT_TOPIC_FILTER                                 | ingestor                         | Tópicos conhecidos; default inclui seed de laboratório         |
| MQTT_CLIENT_ID                                    | ingestor                         | Estável e único; uma réplica nesta POC                         |
| IIOT_WEB_DOMAIN / IIOT_API_DOMAIN                 | configuração Coolify             | Web sim; domínio API opcional                                  |
| MQTT_PUBLIC_HOST                                  | equipamentos/simulador externo   | Host DNS real do broker                                        |
| SUPABASE_URL/SECRET_KEY e NEXT_PUBLIC_SUPABASE_*  | nenhuma aplicação nesta etapa    | Não necessários agora; reservados                              |

A API/web ainda não autenticam usuários. Configurar acesso HTTP restrito no proxy/VPN/allowlist antes de liberar domínio, incluindo `/api` no domínio web. O domínio da API pode permanecer sem publicação. A configuração de produção não transforma este MVP em uma plataforma multiusuário aberta.

## Migrations: etapa controlada

Revisar colisões de tabelas no projeto existente e backup/restauração. Com DATABASE_URL no ambiente privado do operador:

```sh
pnpm install --frozen-lockfile
pnpm db:status
pnpm db:migrate
pnpm db:status
# Somente se deseja criar a POC de desenvolvimento no banco alvo:
pnpm db:seed
```

Alternativa com JavaScript compilado, sem tsx em produção:

```sh
docker compose -f docker-compose.operations.yml build database-tools
docker compose -f docker-compose.operations.yml run --rm database-tools node dist/status.js
docker compose -f docker-compose.operations.yml run --rm database-tools node dist/migrate.js
docker compose -f docker-compose.operations.yml run --rm database-tools node dist/status.js
# Opcional e deliberado:
docker compose -f docker-compose.operations.yml run --rm database-tools node dist/seed.js
```

Executar uma vez por versão, com credencial SQL autorizada. Não configurar esse comando como startup de cada réplica. O lock transacional existente protege contra execução concorrente acidental. O runner não apaga dados nem oferece downgrade destrutivo. Registros legados sem checksum ficam explicitamente não verificados; compará-los ao release aplicado antes de homologar.

## Deploy e verificação

Depois das migrations e antes do tráfego: validar Compose, fazer build/deploy no Coolify, esperar healthchecks e conferir logs por serviço. `/health` da API exige banco acessível; estado broker é diagnóstico adicional e sua falha não deve remover a API de leitura do proxy. `/health` do ingestor distingue live, mqtt/broker, subscribed e database; desconexão retorna 503. `/health` da web verifica seu próprio processo. Mosquitto health testa autenticação/assinatura no listener interno.

Conferir logs `mqtt_connected`, `mqtt_disconnected`, `mqtt_message_received`, `raw_saved`, `adapter_selected`, `telemetry_saved`, `device_unresolved`, `processing_error`, `database_disconnected`, `database_reconnected`. API/ingestor são JSON com service; Next identifica `service=web` no startup e o Coolify identifica seu stream; Mosquitto mantém logs nativos em stdout, separados pelo serviço, com marcador de startup `service=mosquitto`. RAW completo fica no banco, não nos logs.

Não deixar dois ingestors com o mesmo Client ID durante rolling deploy: usar estratégia que encerra o antigo antes de conectar o novo, mantendo sessão e volume do broker. Escala horizontal fica para etapa posterior.

## Persistência, credenciais e TLS

Os quatro volumes do broker pertencem ao recurso Compose estável. O entrypoint copia config/ACL iniciais **somente se não existirem**; redeploy preserva alterações deliberadas. Uma alteração de template no Git não substitui automaticamente o volume existente: revisar e aplicar a atualização ao volume antes de recarregar. Fazer backup de config, hashes e dados; nunca usar down -v como rotina.

Senhas de ingestor/simulator são sincronizadas dos secrets em cada startup, preservando usuários adicionais. Para criar credencial individual A7, usar terminal privado do container broker como root:

```sh
mosquitto_passwd /mosquitto/auth/passwords a7-001
chown 1883:1883 /mosquitto/auth/passwords
chmod 600 /mosquitto/auth/passwords
kill -HUP 1
```

Senha digitada interativamente; não em logs/chat/comando versionado. ACL deve permitir apenas os tópicos desse Device. No primeiro teste, o formato/tópico A7 é desconhecido: usar broker/recurso dedicado de laboratório para a janela de discovery, mantendo firewall por origem. Não conceder write # a equipamento num broker multi-tenant compartilhado.

Renovar o certificado MQTT fora do container, no mesmo diretório montado, e recarregar o broker. Conferir hostname/CA e handshake de 8883 após renovação. Não assumir que certificados HTTP gerenciados pelo Coolify estejam acessíveis ou adequados ao Mosquitto. 1883 continua disponível porque TLS da A7 ainda não foi confirmado; TCP não criptografado pela internet só deve ser usado em túnel/VPN/rede com controles explicitamente acordados.

## Rollback

Guardar commit/imagem anterior e configuração do recurso. Em falha de release, interromper novas conexões do ingestor, voltar imagem/commit via Coolify e preservar volumes. Não reverter schema automaticamente: garantir compatibilidade do release anterior com migrations aditivas; para mudanças futuras incompatíveis, preparar plano próprio de restauração e manutenção. Rodar db:status com a versão adequada; `missing_local_file` pode indicar banco à frente do código. Não executar seed para corrigir rollback.

## Handoff exato para um agente com acesso

Fornecer por canal seguro, sem publicar em Git ou PROJECT_STATUS:

1. URL base da instância Coolify e token API com permissões de criar/configurar/deployar o recurso; projeto UUID, ambiente UUID/nome, servidor UUID e destination UUID (ou nomes inequívocos para localizar).
2. URL do repositório, branch/commit alvo e integração Git/deploy key já autorizada se privado. Arquivo Compose `/docker-compose.production.yml`; Dockerfile raiz com targets da tabela.
3. DATABASE_URL real do projeto Supabase existente em Direct ou Session; CA se exigida; confirmação do projeto alvo, ausência de colisão de nomes IIoT e usuário SQL com privilégios para migrations. Não é necessária SUPABASE_SECRET_KEY.
4. Domínio web, decisão/domínio API, MQTT_PUBLIC_HOST, IP público da VPS e situação de DNS. Acesso DNS só é necessário se o agente também for alterar registros.
5. Diretório dos certificados MQTT na VPS, método de emissão/renovação e arquivos válidos/legíveis; acesso administrativo à VPS apenas se o agente precisar provisionar certificados/firewall fora da API Coolify.
6. Senhas distintas de ingestor e simulator (ou autorização para gerar diretamente nos secrets Coolify), identidade/credencial individual A7, DEV_TENANT_ID e decisão de aplicar seed POC.
7. IPs/CIDRs autorizados para 1883/8883, método de proteção HTTP e janela de captura/discovery. Confirmar disponibilidade das duas portas na VPS e conectividade de saída PostgreSQL.

Não há necessidade de senha Supabase Dashboard, token administrativo Supabase, chave publicável ou Auth nesta preparação.
