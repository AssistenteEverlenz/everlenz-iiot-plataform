# Contrato de variáveis de produção

Lista do que a IHM/CLP precisa publicar para o painel **Gestão à Vista** responder às perguntas
do dono da cerâmica. Cada variável entra no mesmo payload MQTT que já é enviado hoje, como uma
chave escalar no nível principal. Os nomes da coluna "Sugestão" são recomendações; qualquer nome
funciona, porque o papel de cada variável é escolhido no cadastro do equipamento
(`PATCH /api/devices/:id/production-settings`). Enquanto nada é salvo, a plataforma reconhece os
nomes comuns automaticamente.

## Situação da Cerâmica Fortaleza (`EVL-HAI-EC3388CC`) em 10/09/2026

| Papel                | Variável atual      | Situação                                                   |
| -------------------- | ------------------- | ---------------------------------------------------------- |
| Produto / receita    | `NomeReceita`       | ✅ enviada e configurada                                   |
| Paletes              | `QuantidadePaletes` | ✅ enviada, contador                                       |
| Toneladas por hora   | `TonHora`           | ✅ enviada, taxa                                           |
| Linha rodando        | `StatusLinha`       | ✅ enviada                                                 |
| Blocos produzidos    | —                   | ❌ **falta** — o CLP tem, precisa entrar no grupo de envio |
| Toneladas acumuladas | —                   | ⚠️ opcional — hoje estimada integrando `TonHora` no tempo  |
| Peças boas / refugo  | —                   | ❌ falta para a Qualidade do OEE                           |
| Motivo de parada     | —                   | ❌ falta para o Pareto de perdas                           |

## 1. Obrigatórias para a visão gerencial

| Papel               | Sugestão            | Tipo           | Regra                                                                                                         |
| ------------------- | ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| Produto / receita   | `NomeReceita`       | texto          | Enviado **em todo payload**. Ausente ou vazio vira o produto padrão do equipamento; sem padrão, `ITEM GERAL`. |
| Contador de paletes | `QuantidadePaletes` | número inteiro | Acumulativo. Pode zerar (turno, receita, reset); a plataforma soma só os incrementos positivos.               |
| Contador de blocos  | `QuantidadeBlocos`  | número inteiro | Mesma regra do contador de paletes.                                                                           |
| Taxa atual          | `TonHora`           | número (t/h)   | Valor instantâneo da linha. Zero quando parada.                                                               |
| Linha rodando       | `StatusLinha`       | booleano (0/1) | 1 somente com produção efetiva, não apenas máquina energizada.                                                |

Com essas cinco, o painel mostra: produção de hoje e de ontem, 7 dias, mês e ano; mix e ranking
de produtos; média diária; melhor dia; média por dia da semana; toneladas por produto (estimadas);
ritmo atual e disponibilidade do dia.

## 2. Recomendadas

| Papel                | Sugestão         | Tipo               | Ganho                                                                              |
| -------------------- | ---------------- | ------------------ | ---------------------------------------------------------------------------------- |
| Toneladas acumuladas | `ToneladasTotal` | número             | Substitui a estimativa por `TonHora` × tempo por um valor medido pela balança/CLP. |
| Horário da IHM       | `_timestamp`     | texto ISO com fuso | Já enviado; mantém a produção no dia certo mesmo com atraso de rede.               |

## 3. Para o OEE completo

| Componente            | O que falta                                   | Onde entra                                       |
| --------------------- | --------------------------------------------- | ------------------------------------------------ |
| Disponibilidade       | ✅ `StatusLinha` + minutos planejados por dia | Cadastro do equipamento (`plannedMinutesPerDay`) |
| Performance           | Taxa nominal da linha em t/h                  | Cadastro do equipamento (`nominalTonsPerHour`)   |
| Qualidade             | `PecasBoas` e `PecasRefugo` (contadores)      | Payload da IHM                                   |
| Explicação das perdas | `MotivoParada` (código) durante a parada      | Payload da IHM ou apontamento do operador        |

Sem qualidade, o painel mostra Disponibilidade e Performance separadas e informa o que falta, em vez
de exibir um OEE incompleto como se fosse o número real.

## Exemplo de payload

```json
{
  "_timestamp": "2026-09-10T09:16:53-03:00",
  "NomeReceita": "9x19x19",
  "QuantidadePaletes": "21",
  "QuantidadeBlocos": "6720",
  "TonHora": "10.0",
  "ToneladasTotal": "184.6",
  "StatusLinha": "1",
  "PecasBoas": "6650",
  "PecasRefugo": "70"
}
```

## Como a plataforma calcula

- **Por produto:** cada incremento de contador é atribuído ao produto presente naquele payload.
  Trocar a receita no meio do dia divide a produção corretamente entre os produtos.
- **Toneladas sem totalizador:** para cada hora, média da t/h × tempo coberto por amostras. É uma
  estimativa; a tela indica "estimado pela t/h".
- **Dia:** fuso `America/Sao_Paulo`, de 00:00 a 23:59.
- **Tempo rodando:** soma dos intervalos com `StatusLinha = 1`; um intervalo sem dados maior que 5
  minutos não conta como produção.
