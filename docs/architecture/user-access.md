# Usuários, sessões e acesso aos equipamentos

Cada conta pertence a um tenant e possui o papel `master` ou `user`. O master enxerga todos os equipamentos do tenant e administra contas, dispositivos, painéis e identidade visual. O usuário comum enxerga somente os UUIDs registrados em `user_device_access`; esse filtro é aplicado na API, inclusive em telemetria, estatísticas, dashboards e exportações.

O primeiro acesso sempre exige troca da senha temporária. Senhas usam `scrypt` com salt aleatório. A sessão usa um token aleatório de 32 bytes; o navegador recebe o token em cookie HttpOnly, Secure em produção e `SameSite=Strict`, enquanto o banco guarda apenas seu SHA-256. A sessão expira após 12 horas. Desativar, excluir ou redefinir a senha de uma conta remove todas as sessões existentes.

O cadastro e a redefinição exibem a senha temporária uma única vez. O administrador deve entregá-la ao usuário por um canal privado. A tela permite editar nome, e-mail e equipamentos, além de ativar, desativar, redefinir a senha ou excluir a conta.

O status `inactive` já representa o bloqueio administrativo que poderá ser acionado pela integração futura com o Asaas. A cobrança não está integrada nesta entrega.

As tabelas de identidade permanecem inacessíveis às roles públicas do Supabase. A aplicação acessa o PostgreSQL pelo backend e centraliza a autorização no Fastify. RLS continua recomendada como camada adicional quando forem criadas credenciais SQL separadas por serviço.
