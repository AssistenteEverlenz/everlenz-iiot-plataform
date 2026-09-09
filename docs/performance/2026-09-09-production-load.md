# Ensaio de carga de produção — 9 de setembro de 2026

Alvo: `https://iotplataform.everlenz.com.br`. A carga misturou valores atuais, painel, estatísticas de 24 horas e 250 amostras de telemetria. Cada estágio durou 10 segundos, após oito requisições de aquecimento. O critério de parada foi p95 acima de 1,5 segundo ou mais de 2% de erros.

| Solicitado |     Efetivo | Requisições | Erros |      p50 |      p95 |      p99 |
| ---------: | ----------: | ----------: | ----: | -------: | -------: | -------: |
|    5 req/s |  4,99 req/s |          50 |     0 |   282 ms |   626 ms |   632 ms |
|   10 req/s | 10,00 req/s |         100 |     0 |   600 ms |   816 ms |   829 ms |
|   20 req/s | 15,54 req/s |         200 |     0 |   810 ms | 1.221 ms | 1.514 ms |
|   40 req/s | 18,57 req/s |         400 |     0 | 1.264 ms | 2.119 ms | 2.506 ms |

O estágio de 40 req/s atingiu saturação operacional por latência. O servidor não caiu e não perdeu respostas. Logo após o teste, `/health` respondeu 200 em 179 ms, o painel em 416 ms e os valores atuais em 220 ms.

A capacidade conservadora observada é 15,54 req/s efetivos. Um painel configurado em 1 segundo produz aproximadamente duas consultas por segundo considerando valores, configuração, sinais, estatísticas e histórico em frequências diferentes. A recomendação atual é limitar esse modo a seis telas simultâneas, preservando margem; o padrão de 2 segundos suporta mais usuários e continua visualmente em tempo real.

O relatório JSON bruto está em `.runtime/load-production-2026-09-09.json` e não é versionado. O teste pode ser repetido com `pnpm test:load`.
