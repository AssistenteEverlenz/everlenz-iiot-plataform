# Retenção e crescimento

Nenhum RAW é apagado automaticamente. O objetivo atual é conservar a captura da A7 e analisar o protocolo. A durabilidade depende da persistência e capacidade do broker, QoS, conectividade, armazenamento e firmware; não prometer captura sem perda absoluta em QoS 0 ou durante esgotamento de disco/fila.

## Estimativa de capacidade

Defina N = dispositivos, f = mensagens por segundo por dispositivo, P = bytes médios do payload, T = tags normalizadas por mensagem, R = dias de RAW, H = dias de telemetria.

```text
mensagens/dia = N × f × 86.400
amostras/dia = mensagens/dia × T
RAW retido ≈ mensagens/dia × bytes_raw_por_linha × R
telemetria retida ≈ amostras/dia × bytes_amostra_por_linha × H
```

O RAW mantém hexadecimal (cerca de 2P), texto UTF-8 e JSONB quando possível, além de metadados. Para uma estimativa conservadora inicial, usar 4P + 256 bytes por linha RAW e 160 bytes por amostra, **antes de índices, TOAST, compressão, WAL, bloat e backups**. Esses números são hipóteses de planejamento, não medidas do Supabase.

Exemplo P=512 bytes, f=0,5 (uma mensagem a cada dois segundos), T=4, R=30 dias, H=90 dias:

| Dispositivos | Mensagens/dia | Amostras/dia | RAW/dia | RAW 30 dias | Telemetria 90 dias |
| ------------ | ------------- | ------------ | ------- | ----------- | ------------------ |
| 10           | 432.000       | 1.728.000    | 1,00 GB | 29,86 GB    | 24,88 GB           |
| 100          | 4.320.000     | 17.280.000   | 9,95 GB | 298,60 GB   | 248,83 GB          |

GB decimal; adicionar índices e margem operacional separadamente. A taxa real pode subir muito no reenvio de histórico da HMI. Antes de ampliar dispositivos, medir tamanho médio, taxa sustentada/pico, latência de escrita, crescimento de índices e limites contratados do projeto.

Consultas de diagnóstico, somente leitura:

```sql
SELECT relname, n_live_tup, n_dead_tup
FROM pg_stat_user_tables
WHERE relname IN ('mqtt_messages_raw','telemetry_samples');

SELECT pg_size_pretty(pg_total_relation_size('public.mqtt_messages_raw')) raw_total,
       pg_size_pretty(pg_total_relation_size('public.telemetry_samples')) telemetry_total;

SELECT avg(pg_column_size(r)) avg_row_bytes
FROM (SELECT * FROM public.mqtt_messages_raw ORDER BY id DESC LIMIT 1000) r;
```

## Índices e evolução

A migration 001 mantém B-trees para device+timestamp, tag+timestamp, tenant+timestamp, received_at, topic+received_at e status+received_at. Esses índices apoiam as consultas existentes. Há custo de escrita e armazenamento por índice; não remover ou adicionar índices sem `EXPLAIN (ANALYZE, BUFFERS)` com volume representativo. As FKs compostas preservam isolamento de tenant.

| Recurso                         | Quando avaliar                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Batching entre mensagens        | Round trips/latência de rede Supabase dominarem escrita; manter limite de memória, ACK/durabilidade e recuperação definidos |
| Particionamento nativo por data | Retenção/manutenção de tabelas grandes ficar cara; projetar antes a mudança de PK/FKs/uniqueness por timestamp              |
| BRIN em received_at/timestamp   | Dados grandes e fisicamente correlacionados no tempo, onde índice compacto ajuda scans de períodos; comparar com B-tree     |
| Agregações por janela           | Gráficos longos exigirem muitas amostras; preservar RAW e política de qualidade das agregações                              |
| Materialized views              | Leituras agregadas repetidas justificarem custo e atraso do refresh; planejar índices e agendamento                         |
| Retenção                        | Após definir janela de descoberta, auditoria e histórico com o usuário; testar restauração e impacto em FKs                 |

`telemetry_samples.raw_message_id` referencia RAW. Uma política futura precisa definir arquivamento ou desvinculação controlada das amostras antes de remover RAW, sem perder tenant/device. Não implementamos DELETE, job agendado, particionamento nem view materializada nesta preparação.

Definir alertas de capacidade e backups no Supabase/VPS, monitorar volumes Mosquitto e testar recuperação. `autosave_interval` e QoS não são uma garantia de recuperação após falha abrupta de energia; validação de campo deve incluir essas condições de modo controlado.
