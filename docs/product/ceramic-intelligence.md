# Inteligência de produção cerâmica

## Posição do produto

Os sistemas especializados em cerâmica convergem em cinco blocos: visão da fábrica,
rastreabilidade de lotes, qualidade, energia/custos e manutenção. A Everlenz deve entregar esses
mesmos resultados a partir de uma vantagem própria: os fatos de produção nascem dos sinais do
automatismo, com horário e equipamento de origem, em vez de depender de apontamento manual.

O dado em tempo real sozinho não resolve a decisão gerencial. A plataforma deve relacionar cada
amostra a produto, ordem, turno e estado da linha e consolidá-la em eventos e períodos comparáveis.
Isso permite responder perguntas como “por que o OEE caiu ontem?”, “qual produto gera mais
refugo?” e “quanto gás foi consumido por metro quadrado de primeira qualidade?”.

## Referências de mercado

| Plataforma                                                                                                                          | O que oferece                                                                                                                         | O que devemos incorporar                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [SACMI HERE](https://sacmi.com/pt-PT/ceramics/news/8964/here-sacmi-o-seu-parceiro-na-digitalizacao)                                 | Visão da planta, KPI em tempo real, processo, rastreabilidade, qualidade, energia, manutenção, receitas, programação e conexão ao ERP | Linha do tempo única do pedido até a expedição, causas de anomalia e custos industriais  |
| [System Ceramics PRIME](https://www.systemceramics.com/es/noticias/prime-the-benefits-of-digitalization-of-endofline-and-warehouse) | MES/WMS, histórico, ordens, identificação única do palete, armazém e expedição rastreável                                             | Genealogia de produto, lote e palete e contexto comercial associado à produção           |
| [SITI B&T BT-TUTOR](https://siti-bt.com/en/after-sales/)                                                                            | Histórico de energia e matéria-prima relacionado ao lote para cálculo de custo no ERP                                                 | Consumo específico e custo por produto, lote, turno e tonelada ou metro quadrado bom     |
| [just MES Ceramics](https://www.just-mes.com/en/sectors/ceramics)                                                                   | Acompanhamento das etapas de conformação, secagem, queima, esmaltação, decoração e envelhecimento, além de ordem e anomalias          | Modelo de processo cerâmico por etapa, sem limitar o painel a uma máquina isolada        |
| [LB Technology](https://www.lb-technology.com/lb-hybrid-white-paper/)                                                               | Eficiência, controle de processo, consumo, qualidade e sustentabilidade na preparação de massa                                        | Indicadores de matéria-prima, umidade, granulometria, rendimento e consumo na preparação |

## Camadas de informação

### 1. Tempo real operacional

- estado da linha e de cada máquina;
- taxa instantânea em t/h, m²/h, peças/h e paletes/h;
- valor atual versus receita, setpoint e faixa de processo;
- alarmes ativos, duração e primeira causa observada;
- atraso de publicação, processamento e exibição.

### 2. Gestão do turno e do dia

- produção total e boa, meta, desvio e previsão do fechamento;
- OEE e seus três componentes, mostrando qual componente causou a perda;
- horas operando, paradas planejadas, paradas não planejadas e microparadas;
- Pareto de perda por motivo, equipamento, produto e turno;
- velocidade média somente em operação, pico sustentável e tempo abaixo da meta;
- refugo, segunda qualidade, retrabalho e primeira qualidade;
- consumo específico de eletricidade, gás, água e matéria-prima;
- trocas de produto: duração, perda na partida e tempo até estabilização.

### 3. Gestão histórica

- últimos 7 e 30 dias, mês contra mês e ano móvel;
- calendário ou histograma de produção diária, com melhor e pior dia;
- tendência de OEE, produção boa, refugo e consumo específico;
- comparação entre produtos, formatos, tonalidades, calibres, linhas e turnos;
- correlação entre parâmetros de processo e defeitos;
- custo estimado por lote e por unidade vendável;
- recorrência de falhas e indicadores de manutenção.

## Indicadores por etapa cerâmica

| Etapa                 | Indicadores e sinais úteis                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Preparação de massa   | t/h, umidade, densidade/barbotina, resíduo, consumo de água e energia, silos, receita e lote de matéria-prima                    |
| Atomização            | t/h de pó, umidade do pó, temperatura de entrada/saída, pressão, consumo de gás por tonelada e estabilidade                      |
| Prensagem/conformação | ciclos/min, peças/h, pressão, espessura, peso verde, perdas, disponibilidade e tempo de troca de formato                         |
| Secagem               | curva de temperatura, umidade de saída, tempo de residência, velocidade, consumo e peças rejeitadas após secagem                 |
| Esmaltação/decoração  | produto/receita, consumo de esmalte e tinta, velocidade, paradas, defeitos por aplicação e troca de produto                      |
| Queima                | curva real versus receita, velocidade e residência, zonas fora de faixa, gás por m² ou tonelada boa, emissões quando disponíveis |
| Classificação         | primeira e segunda qualidade, refugo por defeito, tonalidade, calibre, formato, operador e origem do lote                        |
| Paletização/expedição | paletes e m² por SKU, código único, ordem, destino, retrabalho, estoque e rastreabilidade                                        |

## Contrato mínimo de dados

O Haiwell aceita chaves escalares no nível principal. Os nomes abaixo são canônicos; o cadastro do
equipamento poderá mapear nomes existentes do CLP para esses papéis sem exigir que toda IHM seja
reprogramada.

```json
{
  "_terminalTime": "2026-09-10T08:15:30-03:00",
  "_groupName": "linha_01",
  "line_running": true,
  "production_rate_tph": 18.7,
  "total_count": 18450,
  "good_count": 17980,
  "reject_count": 470,
  "pallet_count": 312,
  "product_code": "PISO-60X60-BRANCO",
  "production_order": "OP-2026-00481",
  "shift_code": "B",
  "ideal_cycle_seconds": 2.4,
  "target_rate_tph": 20,
  "planned_production": true,
  "downtime_reason_code": "FORNO_ALIMENTACAO",
  "electric_energy_kwh_total": 15842.4,
  "gas_nm3_total": 8231.9
}
```

Regras semânticas:

- contadores devem ser monotônicos e podem voltar a zero; a plataforma soma apenas incrementos e
  reconhece o reset;
- `line_running` deve refletir produção efetiva, não somente máquina energizada;
- produto, ordem e turno são dimensões: uma mudança abre um novo período de produção;
- `planned_production=false` separa parada planejada de perda de disponibilidade;
- motivo de parada pode vir do CLP ou ser classificado por um operador; eventos sem motivo ficam
  como “não classificados” e não são descartados;
- consumo específico usa apenas produção boa no denominador;
- timestamps devem ter fuso explícito. O horário recebido pelo servidor permanece como evidência
  secundária.

## Cálculos

### OEE

- Disponibilidade = tempo operando / tempo de produção planejado.
- Performance = produção total / produção teórica durante o tempo operando.
- Qualidade = produção boa / produção total.
- OEE = disponibilidade × performance × qualidade.

Essa decomposição segue a definição de OEE usada pelo
[NIST](https://nvlpubs.nist.gov/nistpubs/ams/NIST.AMS.100-31.pdf), preservando disponibilidade,
performance e qualidade como valores verificáveis.

O ciclo ideal ou a taxa nominal precisa ser definido por produto e linha. A tela sempre deve abrir os
três componentes e as perdas que explicam o resultado; mostrar somente “80%” não orienta uma ação.

### Taxas e contadores

- t/h usa média por tempo enquanto `line_running=true`; um limite mínimo serve apenas como fallback;
- contador diário é a soma dos incrementos positivos, incluindo a produção após um reset;
- média diária não inclui dias sem programação; dia programado sem produção vale zero;
- comparação usa períodos equivalentes e identifica dias ainda incompletos;
- pico sustentável usa percentil 95 de janelas produtivas, não uma única amostra máxima.

### Paradas

Cada transição de `line_running` abre ou fecha um evento. O evento guarda início, fim, duração,
produto, ordem, turno, equipamento e causa. Limites configuráveis distinguem microparada, parada e
falha longa. A soma desses eventos alimenta disponibilidade, Pareto e análise de causa.

## Arquitetura para escala

Consultas anuais não devem percorrer amostras de dois segundos. O armazenamento será dividido em:

1. amostras brutas e normalizadas para diagnóstico e análise detalhada;
2. estado atual por tag para telas em tempo real;
3. eventos de produção, parada, alarme e troca de produto;
4. consolidações horárias e diárias por equipamento, produto, ordem e turno;
5. snapshots de KPI versionados com a configuração usada no cálculo.

As consolidações precisam ser incrementais e idempotentes. Uma chegada atrasada recalcula somente os
períodos afetados. Esse desenho mantém o painel rápido quando houver centenas de clientes e permite
auditar qualquer número até as amostras que o originaram.

## Ordem de implantação

1. Histórico de taxa e contador com 7/30 dias e comparação anterior.
2. Cadastro dos papéis canônicos e vínculo das tags existentes.
3. Produto, ordem, turno e calendário planejado.
4. Motor de eventos de estado e classificação de paradas.
5. OEE explicável e Pareto de perdas.
6. Qualidade por defeito, tonalidade e calibre.
7. Energia, gás, água e matéria-prima por produto bom.
8. Rastreabilidade de lote/palete e integração ERP.
9. Modelos de correlação, previsão e manutenção preditiva somente após dados confiáveis.
