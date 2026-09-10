# Plataforma industrial configurável

## Experiência implementada

O painel **Gestão à Vista** foi pensado para uso diário no computador e em uma TV. O botão **Adicionar indicador** mostra o catálogo de variáveis que o ingestor descobriu no payload MQTT do equipamento. O operador escolhe nome, visualização, cor, largura e limites. Se a variável ainda não estiver configurada como tag, o próprio fluxo a promove antes de criar o widget.

As visualizações iniciais são valor, estado, medidor, tendência, resumo de produção, OEE e Pareto. A disposição é responsiva e o modo TV remove controles de edição. O navegador imprime uma versão preparada para PDF; CSV e JSON ficam disponíveis na área **Integrações**.

O desenho segue práticas encontradas em plataformas industriais maduras: widgets configuráveis em grade, janelas de tempo real e histórico e layouts próprios para telas grandes. O usuário final pode construir o painel sem alterar código.

## Identidade do equipamento

Cada equipamento possui duas identidades estáveis:

- `id`: UUID interno, usado em relacionamentos, API e autorização futura;
- `device_code`: código humano único no tenant, por exemplo `EVL-A7-0001`, exibido nas telas e etiquetas de campo.

Nome, fabricante, modelo e número de série continuam editáveis sem quebrar integrações. O tópico MQTT é associado ao UUID por `device_topic_mappings`; o sistema não confia em um tenant informado pelo payload.

O cadastro guiado devolve o UUID, o código e uma ficha de conexão com host, porta, TLS, Client ID sugerido e tópico. O estado inicial é `awaiting_connection`. A credencial MQTT individual ainda é ativada pelo operador porque o Mosquitto atual usa arquivo de senhas e ACL com recarga controlada.

## Atualização e capacidade

O menor intervalo disponível no painel é **1 segundo**. Nesse modo, valores atuais são consultados a cada segundo; catálogo a cada 5 segundos; estatísticas a cada 10 segundos; histórico nunca mais rápido que 5 segundos. Isso mantém a sensação de tempo real sem repetir consultas históricas pesadas a cada atualização de valor.

`pnpm test:load` executa uma mistura de consultas reais em estágios crescentes. O teste para ao encontrar mais de 2% de erros ou p95 acima de 1,5 segundo. Esse ponto é tratado como saturação operacional: oferece uma margem mensurável sem provocar deliberadamente indisponibilidade na VPS compartilhada. Em ambiente autenticado, informe `LOAD_SESSION_COOKIE` ou `LOAD_EMAIL` e `LOAD_PASSWORD` de uma conta que já concluiu o primeiro acesso.

No ensaio de 9 de setembro de 2026, o último estágio saudável entregou 15,54 req/s com p95 de 1,22 s e zero erro. A saturação por latência apareceu ao solicitar 40 req/s: 18,57 req/s efetivos e p95 de 2,12 s, ainda com todas as respostas 200. Para a infraestrutura atual, 1 segundo é adequado para até seis painéis ativos simultaneamente com margem; acima disso, use 2 segundos ou adote cache/push antes de ampliar o acesso.

Exemplo contra produção:

```powershell
$env:LOAD_BASE_URL = "https://iotplataform.everlenz.com.br"
$env:LOAD_REPORT_FILE = ".runtime/load-production.json"
pnpm test:load
```

Variáveis opcionais: `LOAD_RPS_STAGES`, `LOAD_STAGE_SECONDS`, `LOAD_TIMEOUT_MS`, `LOAD_P95_LIMIT_MS`, `LOAD_ERROR_LIMIT_PERCENT`, `LOAD_WARMUP_REQUESTS`, `LOAD_DEVICE_ID` e `LOAD_DASHBOARD_ID`. As requisições de aquecimento não entram nas métricas.

## Dados necessários para indicadores industriais

OEE usa a definição `Disponibilidade × Performance × Qualidade`. Para calcular sem adivinhação, cada linha deve publicar ou permitir derivar:

| Indicador        | Sinais necessários                                                          |
| ---------------- | --------------------------------------------------------------------------- |
| Disponibilidade  | estado rodando/parado, início/fim das paradas e tempo de produção planejado |
| Performance      | contagem total, tempo de ciclo ideal e tempo efetivo em produção            |
| Qualidade        | peças boas e refugos, ou contagem total e refugos                           |
| Toneladas/hora   | peso acumulado ou peso por unidade, contador e timestamp confiável          |
| Produção do dia  | contador monotônico ou evento por palete/vagoneta, peso por unidade e turno |
| Pareto de perdas | motivo da parada, categoria e duração de cada evento                        |

O painel já contém os espaços de OEE e Pareto e deixa explícito quando faltam sinais. Assim que as chaves reais do CLP/IHM forem definidas, elas podem ser mapeadas para disponibilidade, contagem boa, refugo, ciclo ideal, tonelagem e motivo de parada.

## Próximas extensões do produto

O escopo, o contrato de sinais e a ordem de implantação da camada gerencial cerâmica estão em
[Inteligência de produção cerâmica](./ceramic-intelligence.md).

1. Perfis de configuração por fabricante/modelo com imagens reais da IHM, campos destacados e instruções versionadas.
2. Eventos de parada e classificação pelo operador para Pareto automático.
3. Agregações horárias e diárias para anos de histórico com custo previsível.
4. Login Supabase Auth, associação usuário/tenant/site/dispositivo e RLS antes de abrir acesso a clientes.
5. Provisionador de credenciais MQTT com ACL por dispositivo, rotação e revogação auditadas.
6. WebSocket ou Server-Sent Events quando a escala justificar push abaixo de um segundo.
