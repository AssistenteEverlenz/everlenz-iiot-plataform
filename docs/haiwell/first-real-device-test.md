# Primeiro teste com a Haiwell A7 real

## Ambiente definitivo: Coolify + Supabase

O teste agora segue A7 → Internet/VPN → Mosquitto da VPS → ingestor → mqtt_messages_raw no Supabase → Inspector. Primeiro execute o [deployment controlado](../deployment/coolify.md), valide com simulador externo usando MQTT_PUBLIC_HOST e só então conecte a A7. Ative discovery e acesso operador apenas numa janela protegida; confira RAW no Supabase via API/SQL. Use TLS 8883 se confirmado no hardware, ou túnel/VPN/acesso por origem controlada para 1883. Não presuma garantia absoluta de entrega; registre QoS, buffering, duplicatas e reconexões.

Os passos abaixo preservam o roteiro funcional e também servem ao laboratório opcional. Na VPS, use o arquivo production, os volumes e os secrets Coolify; não suba o PostgreSQL Docker local. A prioridade é conservar a captura original; não mudar o HaiwellAdapter antes de obter essa evidência.

Roteiro manual de laboratório, somente leitura. Não modifica automaticamente o projeto Haiwell nem envia comandos ao CLP/IHM. Faça backup do projeto existente antes da intervenção manual planejada.

1. Execute `pnpm env:setup` e `pnpm docker:up`. Confirme `docker compose ps` e `/health`.
2. Execute `pnpm simulator:haiwell` e `pnpm test:e2e`. Confira quatro tags no dispositivo e RAW no Inspector. Interrompa o simulador antes de conectar a A7 para não misturar capturas.
3. Ative `MQTT_DISCOVERY_MODE=true` e `OPERATOR_RAW_ACCESS=true` no `.env`; recrie ingestor/API. Confirme `discovery: true` em `http://localhost:3002/health`.
4. Crie a credencial temporária individual `a7-001` com o procedimento interativo de [segurança MQTT](../architecture/mqtt-security.md). Não use a senha do ingestor ou simulador na HMI.
5. Mantenha acesso controlado: interface/IP de laboratório em `MQTT_BIND_ADDRESS`, firewall permitindo somente o IP da A7, nenhuma exposição pública. A ACL inicial permite o tópico experimental; isso pode não ser suficiente para a descoberta real. Consulte logs de publicação negada. Se o tópico for totalmente desconhecido, pode-se temporariamente conceder `topic write #` **somente ao usuário A7 em broker dedicado e isolado, sem outros equipamentos/tenants**, numa janela de captura. Não faça isso em broker compartilhado. Remova essa permissão assim que descobrir o tópico.
6. No Haiwell Cloud SCADA, configure manualmente o endereço alcançável do nosso broker (IP da máquina na LAN, nunca `localhost` da HMI), porta de laboratório e credencial específica. Registre o identificador de projeto configurado. Se TLS estiver disponível, valide separadamente CA e hostname; não presuma suporte.
7. Configure um grupo de histórico com armazenamento remoto, conforme os controles disponíveis na versão atual do software.
8. Comece com 3–5 variáveis de leitura: temperatura, corrente_motor, status, contador e velocidade. Registre endereços, tipo esperado, escala e unidade. O seed não inclui contador; ele aparecerá inicialmente apenas no RAW até criar a Tag correspondente.
9. Faça o download manual do projeto na HMI, seguindo o procedimento operacional autorizado para o equipamento.
10. Observe conexão/autenticação nos logs: `docker compose logs -f mosquitto ingestor`. Uma assinatura `#` não supera a ACL de publicação.
11. Observe tópicos e horários no MQTT Inspector. Compare relógio da HMI e horário do computador.
12. Salve a captura RAW completa (hexadecimal e JSON/texto), tópico, QoS entregue, retain e timestamp. No Inspector copie os bytes ou consulte `mqtt_messages_raw` no psql. Mantenha a captura em diretório privado fora do Git; revise dados sensíveis antes de compartilhá-la.
13. Registre formato encontrado, firmware/software, configurações do teste, frequência de envio e tabela de variáveis. Veja [capture-template.md](capture-template.md).
14. Ajuste o mapping do DeviceResolver e o HaiwellAdapter com base na evidência. Crie fixtures anonimizadas e testes de regressão. Não renomeie o GenericJsonAdapter para acomodar particularidades da Haiwell.
15. Repita a captura, confira correspondência variável a variável e faça testes controlados de desconexão/reconexão, duplicatas e histórico. Valide a decisão de timestamp antes de interpretar tendência histórica.
16. Só depois remova Discovery Mode, desative acesso operador a RAW sem tenant, configure `MQTT_TOPIC_FILTER` com tópicos necessários, restrinja a ACL ao tópico real e rotacione/revogue a credencial temporária. Recrie ingestor/API e recarregue ACL. Confirme que mensagens inesperadas deixaram de ser recebidas.

## Critério de sucesso

Conexão autenticada, tópico conhecido, RAW íntegro, Device associado ao tenant correto, tags normalizadas coerentes com a HMI e valores atuais/gráficos visíveis. Mensagens desconhecidas permanecem no banco. Não aprovar uso em produção somente porque há conexão MQTT: reconciliar tipos, timestamp, unidades e comportamento offline.
