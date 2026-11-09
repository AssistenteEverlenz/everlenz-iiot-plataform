---
name: pnl
description: Base de comportamento humano da Everlenz para desenhar telas, painéis, relatórios, modais e textos da plataforma IIoT que a pessoa da fábrica entende de primeira, e para ler o uso real (usage_minutes, usage_events) e descobrir onde ela trava. Use ANTES de criar ou mudar tela, card, gráfico, relatório, botão, aviso ou fluxo, e ao analisar o comportamento dos usuários. Gatilhos: "tela", "layout", "painel", "card", "relatório", "modal", "botão", "texto da tela", "intuitivo", "fácil de ler", "o cliente não entende", "onde trava", "uso da plataforma", "PNL".
---

# PNL Everlenz IIoT: como a pessoa da fábrica olha, entende, decide e age

Objetivo: **a pessoa vê primeiro o que mais importa, entende sem esforço e sabe o que fazer em seguida.**
"Conduzir" quer dizer levar a atenção para o que é verdade e útil, nunca esconder ou exagerar: o dono
da cerâmica confia nos nossos números, e essa confiança é o produto. A versão completa desta base (com
fontes e os livros que inspiram) está na Comitiva: `everlenz-gestao-frotas/.claude/skills/pnl/SKILL.md`.

## Antes de desenhar (3 linhas, por escrito)

1. **Quem olha**: dono (quer saber se está produzindo e ganhando), gerente/supervisor (linha parada,
   meta do turno, quem fez o quê), operador (o que lançar agora), ou a TV na parede (ninguém clica).
2. **Em que situação**: escritório com calma, celular no pátio, TV a 5 m de distância, reunião.
3. **A UMA pergunta** da tela: "a linha está rodando?", "vou bater a meta do mês?", "por que parou?",
   "a contagem está certa?".

## As leis (resumo)

- **Imagem antes de texto**: ícone em todo título e botão; comparação e tendência viram gráfico; estado
  vira sinal (selo com ícone, ▲/▼, barra cheia/vazia). Tabela só para conferir linha a linha, depois do gráfico.
- **Um número herói por tela**, em cima à esquerda, com a referência ao lado (meta, turno anterior, mês
  anterior, mediana). Um número sozinho não diz se é bom. Unidade padrão da cerâmica: milheiros, depois t,
  depois paletes.
- **Até ~5 opções visíveis** (Hick); o resto atrás de "Mais"/filtro. Resumo primeiro, detalhe quando pede
  (o "i" ao lado de cada número diz de onde ele vem).
- **Enquadramento concreto**: "a linha ficou 2 h 10 min parada e deixou de fazer 18 milheiros" move mais
  que "disponibilidade 82%". Perda real em quantidade, tempo e R$.
- **Um botão principal por tela/modal**, com verbo que diz o que acontece ("Salvar turno", "Corrigir
  contagem"), nunca "OK".
- **Cores fixas**: verde = produzindo/meta batida; vermelho = parada/erro de verdade; âmbar = atenção;
  azul = informação; cinza = sem dado ou offline. Tempo sem IHM nunca é parada (cinza, não vermelho).
  Cor nunca sozinha: sempre com ícone, sinal ou palavra. A cor de destaque das telas novas é `--brand-accent`.
- **Retorno em 0,1 s** a todo clique (botão muda, "Salvando…"). Sem retorno a pessoa clica de novo: é o
  que aparece como `repeat` nos dados.
- **Começo e fim**: a tela abre pelo resumo e termina no próximo passo; fluxos terminam com confirmação clara.
- **TV**: leitura a distância, sem interação; números grandes, poucos, e o estado da linha em cor.

## Checklist antes de entregar

- [ ] Sei quem olha, em que situação e qual a UMA pergunta da tela.
- [ ] Número herói no topo à esquerda, com referência ao lado e "i" dizendo de onde vem.
- [ ] Ícone em todo título e botão; comparação/tendência em gráfico.
- [ ] Até ~5 opções visíveis; um só botão principal com verbo.
- [ ] Cores com significado fixo e nunca sozinhas.
- [ ] Língua da fábrica (milheiro, palete, turno, parada, receita), sem jargão técnico (tag, payload, MQTT)
      fora das telas de configuração.
- [ ] Estados vazio, carregando, erro e "sem IHM" escritos.
- [ ] Celular sem rolagem lateral, alvos ≥ 44 px; TV legível a distância.
- [ ] Teste dos 5 segundos: a mensagem principal aparece sem ler o resto.

## Proibido

Urgência falsa · número sem fonte ou arredondado para parecer melhor · esconder offline ou correção de
contagem · gráfico com eixo cortado para exagerar · cor de "bom" em resultado ruim · culpar a pessoa no texto.

## Observar: o que o usuário faz, onde trava, o que não entende

Dois registros, ambos gravados pelo navegador de quem está logado:

- **`usage_minutes`** (042, `useUsageBeat`): uma linha por pessoa por minuto com a plataforma na tela;
  `path`, `active` (mexeu nos últimos 2 min), `tv`, `device`. A página "Uso da plataforma" do master lê isso.
- **`usage_events`** (056, `useUsageEvents` em `apps/web/components/useUsageEvents.ts`): os momentos.
  Nenhuma tela da plataforma lê esta tabela: a análise é nossa, direto no banco. Fica 90 dias (o job de
  retenção da API apaga o resto). Não guarda o que foi digitado; o `target` é o nome do controle com os
  dígitos trocados por `#`.

| `kind` | O que é | O que costuma indicar | Ação típica |
|---|---|---|---|
| `screen` | `ms` numa página até sair dela | o que de fato importa para cada perfil | subir para a tela inicial |
| `click` | o controle usado (`target`) | caminho real; recurso nunca usado | mover, ensinar ou tirar |
| `repeat` | 3 cliques em 0,8 s no mesmo ponto | parece clicável e não é, ou está lento | tornar clicável ou dar retorno |
| `dead` | clique num card onde nada reage | a pessoa esperava uma ação ali (abrir o detalhe) | criar a ação esperada |
| `modal` | janela fechada em < 2 s sem salvar (`target` = quem abriu) | caminho errado | mudar rótulo ou posição |
| `form_abandoned` | digitou numa janela e fechou sem salvar | atrito no lançamento | simplificar, mudar padrão |
| `empty_search` | busca sem resultado (`target` = lista · tamanho) | a pessoa chama a coisa por outro nome | aceitar o nome dela |
| `error` | erro de script que a pessoa encontrou | defeito | corrigir |

Buscas sem resultado só são registradas onde a página liga `useEmptySearch` (Painéis, Dispositivos ·
cliente, Usuários, Usuário · equipamentos). Ao criar uma lista com busca, ligue também.

### Consultas (somente leitura, base de produção)

Excluir as contas da Everlenz e de teste das análises (`app_users.email` da Everlenz/sistema) e olhar por
cerâmica (`tenant_id`), porque cada cliente tem uma rotina diferente.

```sql
-- o que cada perfil mais abre e quanto tempo fica (30 dias)
select e.role, e.path, count(*) vezes, round(avg(e.ms)/1000) seg_medio
  from usage_events e where e.kind='screen' and e.at > now()-interval '30 days'
 group by 1,2 order by 1,3 desc;
-- onde a pessoa trava
select e.kind, e.path, e.target, count(*) n, count(distinct e.user_id) pessoas
  from usage_events e
 where e.kind in ('repeat','dead','modal','form_abandoned','empty_search','error')
   and e.at > now()-interval '30 days'
 group by 1,2,3 order by pessoas desc, n desc limit 40;
-- o caminho de cada perfil: os controles mais usados
select e.role, e.path, e.target, count(*) from usage_events e where e.kind='click'
 group by 1,2,3 order by 1,4 desc;
-- celular x computador por pessoa (minutos)
select u.full_name, count(*) filter (where m.device='mobile') celular,
       count(*) filter (where m.device='desktop') computador
  from usage_minutes m join app_users u on u.id=m.user_id
 where not m.tv and m.minute > now()-interval '30 days' group by 1 order by 2 desc;
```

**Regra de leitura**: um sinal só vira mudança de tela quando aparece em **várias pessoas** (coluna
`pessoas`), não numa só, e a mudança é medida de novo depois (antes × depois). Registrar aqui o que
foi aprendido a cada leitura.

## Aprendizados desta plataforma

- Tempo sem IHM nunca é parada de linha (Galo teve 39% offline): mostrar à parte, em cinza.
- Período anterior com < 60% dos dias produzidos não é comparado (cerâmicas novas davam "+1.000%").
- Um número que tem diferença passa pela verificação de produção e mostra a causa com data.
