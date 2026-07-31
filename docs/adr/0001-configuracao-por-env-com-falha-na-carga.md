# 0001 — Configurar via variáveis de ambiente com falha na carga do módulo

- Status: aceita
- Data: 2026-07-29

## Contexto e problema

Este projeto é um fork higienizado de um emissor que tinha CNPJ, Inscrição Municipal, código do município, caminho e senha do certificado e regime tributário hardcoded no código-fonte. Esses dados pertenciam a terceiros e impediam o fork; além disso, emitir uma nota fiscal com dado de prestador errado produz um documento oficial errado e difícil de corrigir. Era preciso decidir de onde viria a identidade fiscal do prestador e como reagir quando essa configuração estivesse ausente ou incorreta.

## Decisão

Toda a identidade do prestador e os parâmetros fiscais passaram a vir de variáveis de ambiente, lidas por `config.ts`, sem nenhum default de produção. Configuração ausente ou malformada chama `process.exit(1)` com uma mensagem que nomeia a variável em falta, **no momento da carga do módulo** — antes de qualquer chamada à SEFIN. `config.ts` valida a contagem de dígitos do CNPJ (14) e do código IBGE do município (7), confirma a existência do arquivo do certificado no disco e recusa códigos de regime tributário fora da lista prevista no layout (`opSimpNac`, `regApTribSN`, `regEspTrib`, `NFSE_AMBIENTE`).

## Consequências

### Positivas

- Nenhuma credencial ou dado fiscal de terceiro entra no código-fonte ou no histórico do git.
- Erro de configuração aparece imediatamente, com o nome exato da variável, em vez de estourar no meio de uma emissão.
- Validações de formato (dígitos de CNPJ, código IBGE, existência do certificado, valores de regime tributário) pegam erros de digitação antes de qualquer chamada de rede.

### Negativas / custo aceito

- Como a validação roda na carga do módulo, importar `emissor.ts` exige `.env` completo e certificado presente no disco — isso torna o módulo não-importável em teste sem uma configuração real, e foi a razão pela qual a montagem da DPS (Declaração de Prestação de Serviço) foi extraída para um módulo puro separado, testável sem depender de `config.ts`.

## Alternativas consideradas

### Defaults de produção no código — rejeitada

Foi exatamente o problema do repositório de origem: dado fiscal hardcoded, difícil de auditar e impossível de abrir para o fork.

### Validação preguiçosa no primeiro uso — rejeitada

O erro apareceria no meio de uma emissão, potencialmente depois de efeitos colaterais (chamada à SEFIN já em andamento), em vez de falhar cedo e de forma isolada.

### Biblioteca de schema (ex.: zod) — rejeitada

Seria uma dependência nova para validar cerca de doze campos; as validações manuais em `config.ts` (contagem de dígitos, `existsSync`, listas de códigos permitidos) cobrem o caso sem adicionar peso ao projeto.

## Atualização — 2026-07-30: ambiente padrão seguro

`NFSE_AMBIENTE` passou a ter default `2` (produção restrita, sem valor fiscal) quando a variável não é definida, em vez de exigir o preenchimento explícito sem default. Antes dessa mudança, quem preenchia o `.env` na mão e deixava esse campo em branco podia cair direto em produção real sem perceber — e uma nota emitida em produção é irreversível. Errar para o lado seguro custa preencher uma variável (`NFSE_AMBIENTE=1`) para emitir de verdade; errar para o outro lado custa um documento fiscal. Emitir de verdade agora exige definir `NFSE_AMBIENTE=1` explicitamente no `.env`.
