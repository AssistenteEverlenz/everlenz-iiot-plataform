# Haiwell A7: fatos, hipótese e validação de campo

Primeiro equipamento planejado: Haiwell Série A, modelo A7, 7 polegadas, projeto no Haiwell Cloud SCADA. A arquitetura recebe outros fabricantes via adapters separados.

## Base documental

O [guia oficial Haiwell HMI/CBOX/IPC MQTT Configuration Guide](https://en.haiwell.com/daruanjianen/Haiwell%20MQTT%20Configuration%20Guide.pdf), páginas 16–17, descreve programação SCADA com grupo de histórico, armazenamento remoto, variáveis/identificadores de envio, níveis de QoS e servidor MQTT no centro de dados. O exemplo antigo usa porta 1883 e identificação de projeto. Essa documentação histórica sustenta o roteiro, mas não comprova protocolo, firmware ou TLS da A7 em mãos.

Nomes de campos fornecidos no briefing para localizar na interface: History Record Group; Storage Mode / Remote Storage; Upload Identification; Remote Identification; QoS 0, 1 e 2; Data Center; MQTT Server; Server Host; Port; Server Project Identifier; Username; Password. Validar a nomenclatura na versão instalada do Cloud SCADA.

Não copiar automaticamente o projeto da HMI, configuração MySQL ou servidor do guia antigo: nossa recepção é Mosquitto + ingestor + PostgreSQL. Nenhuma ferramenta deste projeto modifica ou baixa automaticamente um projeto Haiwell.

## Hipótese experimental

`HAIWELL_FORMAT_HYPOTHESIS` aparece junto ao schema em `packages/adapters/src/index.ts`. O tópico e payload abaixo são **hipótese inicial fornecida no briefing**, não formato confirmado pela documentação oficial nem por captura de hardware:

```text
data/{ProjectCode}/{GroupIdentifier}/{TerminalCode}
```

```json
{
  "_terminalTime": "2026-09-07T12:00:00Z",
  "_groupName": "group1",
  "temperatura": "65.2",
  "corrente_motor": "387.4",
  "velocidade": "42",
  "status": "1"
}
```

O HaiwellAdapter aceita essas strings sem presumir seu tipo. Uma Tag number converte `"123.45"` para 123.45; Tag boolean converte `"1"`/`"0"`; Tag string preserva `"1"`. Somente tags cadastradas são normalizadas. Metadados prefixados por `_` não se tornam tags.

Timestamp ISO com timezone explícito é utilizado; timestamps desconhecidos/sem timezone usam horário de recepção com qualidade `timestamp_fallback`. Essa decisão evita interpretar silenciosamente hora local como UTC. O RAW permite corrigir a interpretação depois da captura real.

Não depende do formato do tópico dentro do parser: o DeviceResolver associa tópico ao equipamento por mapping, e o adapter interpreta somente o conteúdo. O seed usa `data/POC/group1/A7-001`. Uma mensagem diferente é preservada como unrecognized/error para análise.

## Informações que ainda precisam ser descobertas na A7 real

- Versões do hardware, firmware e Haiwell Cloud SCADA; versão MQTT efetiva e Client ID.
- Tópico real, payload real, encoding e formato/timezone do timestamp.
- Comportamento QoS, retained messages, reconnect e keepalive.
- Suporte TLS, configuração de certificado CA e validação de hostname versus IP.
- Comportamento offline, buffer local e envio do histórico após reconexão.
- Agrupamento de variáveis, chaves publicadas, tipos e separadores decimais.
- Duplicatas, ordenação e mudanças de tópico em diferentes projetos/grupos.

O [roteiro de campo](first-real-device-test.md) produz evidência para substituir a hipótese. Não declarar suporte TLS da A7 até testá-lo na unidade e software reais.
