# Supabase PostgreSQL

## Uso atual

O Supabase existente passa a ser o banco definitivo. Ingestor e API usam `pg`, SQL parametrizado e transações PostgreSQL via `DATABASE_URL`. Não usamos REST/PostgREST, SDK Supabase, Auth ou Realtime para ingestão. PGlite permanece exclusivamente em testes.

Aceitamos a URL fornecida em **Connect → Direct Connection** ou **Session pooler**. Preservamos hostname, usuário (inclusive sufixo do projeto), porta, banco e senha codificada na URL. Não inferimos o tipo de conexão pelo hostname. Direct exige conectividade compatível com o endereço oferecido; Session pooler é uma opção para redes IPv4. Use Session Mode para os processos persistentes deste projeto; não selecionar Transaction Mode nesta etapa. [Documentação oficial de conexão](https://supabase.com/docs/guides/database/connecting-to-postgres).

`DATABASE_URL` é suficiente quando a cadeia TLS é reconhecida pelo Node. O default é validar certificado **e hostname**, inclusive se a URL vier com `sslmode=require` (promovido para validação completa). `sslmode=verify-full` também é aceito. Não existe fallback para PostgreSQL local.

Se a cadeia do endpoint exigir CA própria, obtenha o certificado CA pelo projeto Supabase e configure `DATABASE_SSL_CA_PEM` como secret multiline do servidor ou `DATABASE_SSL_CA_FILE` como caminho para arquivo montado. Não use certificado de outro projeto nem desligue a validação. O Compose passa a opção PEM; arquivo é uma alternativa para execução fora desse Compose. Não configure as duas opções simultaneamente.

Parâmetros URL que substituem a configuração TLS (`ssl`, `sslcert`, `sslkey`, `sslrootcert`, `uselibpqcompat`) são rejeitados. A URL é saneada antes de ser passada ao pg para impedir sobrescrita da configuração `ssl`. `sslmode=disable` é permitido apenas explicitamente fora de `NODE_ENV=production`, para PostgreSQL de desenvolvimento. Nunca configurar `NODE_TLS_REJECT_UNAUTHORIZED=0`. [TLS no node-postgres](https://node-postgres.com/features/ssl).

## Migrações e auditoria

- `001_initial.sql` foi preservada. Usa UUID nativo `gen_random_uuid`, BIGSERIAL, JSONB, timestamptz, FKs, índices B-tree e funções SQL presentes no PostgreSQL do Supabase. Não exige Timescale, extensões não padrão ou privilégios de superuser para criar o schema da aplicação.
- `002_server_only_access.sql` revoga privilégios PUBLIC/anon/authenticated **somente nos objetos IIoT**, preservando outras tabelas do projeto. Os testes criam roles e grants simulando Supabase e verificam a revogação. Não habilita RLS, não cria policies nem altera Auth.
- O runner mantém `public.schema_migrations`, transação, lock PostgreSQL e SHA-256 de SQL com finais de linha normalizados. Divergência de checksum impede reaplicação. Registros antigos sem checksum permanecem `applied_unverified`; não são certificados retroativamente.
- `pnpm db:status` somente consulta o catálogo, mostra pending/applied/applied_unverified/checksum_mismatch/missing_local_file e não executa migration. `pnpm db:migrate` é uma ação deliberada do operador/deployment. `pnpm db:seed` aplica o seed POC de modo idempotente, nunca automaticamente em produção.

O schema é `public`, preservando o projeto existente. Antes da primeira aplicação no Supabase **já existente**, conferir colisão dos nomes tenants/sites/devices/tags/device_topic_mappings/mqtt_messages_raw/telemetry_samples/device_status/schema_migrations. Uma colisão não deve ser resolvida apagando dados nem marcando migrations como aplicadas. Se o projeto já possuir tabelas homônimas, parar e definir migração/namespace dedicado. CREATE TABLE falha e a transação reverte; não há adoção automática de tabelas de outro produto.

Use inicialmente uma conexão SQL com privilégios para criar e alterar os objetos, acessível somente ao operador. Para o runtime, planeje usuários SQL dedicados com privilégios mínimos por serviço; cada serviço aceita sua própria DATABASE_URL no Coolify. A configuração base compartilha a URL para simplificar a primeira POC. O número de conexões máximo inicial é 5 por processo, configurável por `DATABASE_POOL_MAX`; somar API, ingestor, réplicas e ferramentas ao dimensionar o pool do Supabase.

## Fronteira servidor/browser

| Variável                             | Local                                            | Uso nesta versão                                    |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| DATABASE_URL                         | API, ingestor, ferramenta de migrations          | SQL direto; secret, nunca browser/build arg         |
| DATABASE_SSL_CA_PEM / FILE           | Servidor                                         | Confiança TLS opcional, sem desligar verificação    |
| SUPABASE_SECRET_KEY                  | Exclusivamente servidor, se necessária no futuro | Não utilizada nem injetada nos containers atuais    |
| SUPABASE_URL                         | Servidor                                         | Reservada; não necessária ao pg                     |
| NEXT_PUBLIC_SUPABASE_URL             | Browser futuramente                              | Reservada para Auth, ainda não utilizada            |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | Browser futuramente                              | Chave publicável, não uma credencial administrativa |
| NEXT_PUBLIC_API_URL                  | Browser                                          | `/api`, proxy Next.js de mesma origem               |

Não é necessário fornecer secret key, publishable key ou token administrativo Supabase para este deployment. A identidade SQL está em DATABASE_URL. O frontend não recebe credenciais de banco ou MQTT. O Docker exclui `.env*`, certificados e chaves do contexto; variáveis públicas futuras devem ser consideradas públicas e seus requisitos de build reavaliados quando Auth for implementado.

## Futura Auth e RLS

Tenant continua explícito em sites/devices/tags/mappings/RAW/amostras/status; FKs compostas impedem vínculos entre tenants. O ingestor é um processo confiável multi-tenant; RAW sem identificação tem tenant_id NULL e fica em quarentena de operador. Não conceder acesso de usuário comum a essa quarentena.

No futuro: mapear `auth.uid()` a memberships, derivar contexto do token verificado no servidor, criar policies com tenant_id e índices apropriados, separar papel do ingestor/operador e só então conceder acesso a anon/authenticated conforme necessário. Usuários SQL proprietários/BYPASSRLS exigem tratamento distinto; ativar RLS sem revisar essas conexões não basta.

Enquanto isso, a migration 002 impede que a chave publicável acesse tabelas IIoT pela Data API mesmo sem RLS. Confira os grants efetivos no projeto real, inclusive roles herdadas, antes de publicar. Migrations futuras devem revogar grants dos novos objetos IIoT na mesma transação. Não alteramos default privileges globais nem desativamos a Data API inteira de um projeto existente. [Segurança da Data API](https://supabase.com/docs/guides/api/securing-your-api).

Web/API continuam sem autenticação de usuário: proteger acesso HTTP no proxy/VPN/allowlist durante a POC. Não confundir TLS ou isolamento SQL com autorização do navegador.
