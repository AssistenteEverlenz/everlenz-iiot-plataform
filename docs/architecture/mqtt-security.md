# Segurança MQTT

Para a VPS Coolify, use o [procedimento de produção](../deployment/coolify.md): Compose independente com portas TCP 1883/8883, certificados da VPS e config/ACL em volume persistente. Os comandos de arquivos bind-mounted abaixo descrevem o laboratório local. Em produção, atualize o volume de configuração deliberadamente; templates no Git não sobrescrevem esse volume no redeploy.

## Autenticação e ACL

Mosquitto self-hosted exige autenticação (`allow_anonymous false`). `mqtt-init` usa `mosquitto_passwd` para criar hashes em volume privado; não há senha real no Git. O `.env` recebe valores aleatórios com `pnpm env:setup`. Preserve os nomes de serviço `ingestor` e `simulator` ou altere também ACL e validação do init.

O ingestor é uma identidade confiável de infraestrutura com leitura global para discovery; não possui permissão de publicação. O simulador só publica nos dois tópicos seed. Cada equipamento real deve ter usuário/senha próprios e permissões de publicação exatas. Nunca use uma credencial de ingestor no equipamento.

Provisionamento interativo da identidade A7 de exemplo, com a stack iniciada:

```sh
docker compose run --rm --entrypoint mosquitto_passwd mqtt-init /mosquitto/auth/passwords a7-001
docker compose run --rm --entrypoint sh mqtt-init -c "chown 1883:1883 /mosquitto/auth/passwords && chmod 600 /mosquitto/auth/passwords"
docker compose kill -s HUP mosquitto
```

A senha é digitada no prompt. O exemplo da ACL já contém `user a7-001` com escrita somente em `data/POC/group1/A7-001`. Isso é uma hipótese: ajuste para o tópico capturado quando conhecido. Adicionar credencial não cadastra automaticamente o Device; mantenha cadastro SQL e mapping coerentes.

Credenciais de novos equipamentos seguem o mesmo procedimento e recebem sua própria entrada `user`/`topic write` em `infrastructure/mosquitto/config/acl`. Revogar: remover ACL e senha (`mosquitto_passwd -D` no volume), recarregar e desconectar a sessão existente durante janela controlada. Uma simples recarga do arquivo de senha não garante expulsão imediata de clientes já conectados.

## Isolamento entre tenants

ACL vincula a identidade MQTT ao tópico do próprio equipamento. O resolver vincula esse tópico a um único Device/Tenant. Um payload não pode escolher livremente seu tenant. Tópicos proprietários precisam de prefixos/mappings não ambíguos. Cadastros sobrepostos são rejeitados pelo resolver em tempo de processamento.

Discovery (`#`) amplia leitura do ingestor, **não autoriza publicação** de equipamentos em qualquer tópico. RAWs desconhecidos ficam sem tenant e não aparecem na API normal. `OPERATOR_RAW_ACCESS=true` é uma exceção deliberada para operador local; substituir por autorização administrativa real antes de disponibilizar a aplicação a usuários.

## TCP 1883

MQTT sem TLS não protege credenciais nem payload contra observadores da rede. O Compose publica 1883 em `127.0.0.1` por padrão. Para uma A7 na LAN, configure `MQTT_BIND_ADDRESS` com o IP da interface do laboratório, recrie o broker e libere no firewall somente a origem da A7. Não faça redirecionamento da porta 1883 no roteador para a internet.

API, banco, web e healthcheck também ficam em loopback no Compose. Na rede interna Docker, serviços comunicam por nome. A web exige login e a API combina tenant da sessão com os equipamentos atribuídos ao usuário.

## TLS 8883

O repositório inclui configuração e overlay opcionais. Não inclui certificados públicos falsos nem desativa validação de certificado nos clientes.

1. Obtenha certificado válido para o hostname real do broker, com cadeia completa e chave privada.
2. Coloque `fullchain.pem` e `privkey.pem` em diretório fora do Git, acessível ao usuário 1883 do Mosquitto. A chave deve ter acesso restrito.
3. Defina `MQTT_TLS_CERT_DIR` com caminho absoluto no `.env`. Defina `MQTT_TLS_BIND_ADDRESS` com a interface controlada a publicar; padrão loopback.
4. Execute:

```sh
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build --wait
```

5. Use hostname correspondente ao certificado, porta 8883 e TLS no equipamento/cliente. Para clientes Node externos, `MQTT_PROTOCOL=mqtts`, `MQTT_PORT=8883`, `MQTT_HOST=<hostname>`, e `MQTT_CA_FILE` se usar CA privada. `rejectUnauthorized` permanece true.
6. Planeje renovação e recarga controlada do broker; teste CA/hostname expirados ou incorretos como casos de rejeição.

O overlay adiciona TLS externamente; os serviços do Compose mantêm o listener TCP na rede interna isolada. Mantenha `MQTT_PORT=1883` no `.env` da stack e configure clientes TLS externos no ambiente de seu processo para não alterar a porta publicada do listener de laboratório. Para eliminar TCP em produção, redesenhe também URLs, healthchecks, certificados e rede interna antes de desativar 1883. TLS público por si só não torna a plataforma web pronta para produção.

## Equipamentos antigos

Não se confirmou suporte TLS da A7 específica. Se não houver, conecte por VLAN industrial isolada com VPN entre local e datacenter, ou gateway de borda que termine MQTT TCP somente na rede física controlada e encaminhe por TLS. Não exponha a HMI nem sua porta MQTT diretamente à internet. Valide reconexão e buffering reais antes de adotar qualquer gateway.

## Logs e dados brutos

Credenciais de conexão não são registradas pelos serviços. Discovery registra metadados e prévia limitada do payload; RAW preserva conteúdo completo. O conteúdo enviado pelo equipamento pode ser sensível: restrinja acesso aos logs e ao banco. Não publique dumps de campo sem revisar informações de processo e identificadores.

Referências oficiais: [autenticação Mosquitto](https://mosquitto.org/documentation/authentication-methods/) e [configuração Mosquitto](https://mosquitto.org/man/mosquitto-conf-5.html). Esta stack usa a linha Mosquitto 2; mudanças de versão principal exigem revisar configuração e compatibilidade.
