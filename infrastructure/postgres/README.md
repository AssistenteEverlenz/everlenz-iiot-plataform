PostgreSQL 17 local é opcional e pertence exclusivamente ao profile development de docker-compose.yml. Produção usa o projeto Supabase existente via DATABASE_URL, sem container PostgreSQL. O volume local postgres-data foi preservado para não apagar dados da base aprovada.

As migrations estão em packages/database/migrations. O laboratório pode executá-las pelo serviço migrate; em produção execute a etapa controlada documentada em docs/deployment/coolify.md. Nunca altere uma migration aplicada: adicione a próxima migration numerada. Use pnpm db:status para auditoria.
