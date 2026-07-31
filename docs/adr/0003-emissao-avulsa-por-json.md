# 0003 — Emissão avulsa por arquivo JSON, não por script por cliente

- Status: aceita
- Data: 2026-07-29

## Contexto e problema

O repositório de origem acumulava um script one-shot por cliente, cada um com nome, CNPJ, endereço e descrição do serviço embutidos diretamente no código. Esse padrão impedia o fork — os dados eram de terceiros e não podiam ir para um repositório público ou compartilhado — e obrigava a editar código toda vez que fosse preciso emitir uma nota avulsa para um tomador novo.

## Decisão

Um único script, `emitir-avulsa.ts`, lê os dados da nota de um arquivo JSON informado na linha de comando (`nfse emitir <nota.json> --real`). O script valida a presença dos campos obrigatórios (`idVenda`, `tomador`, `xDescServ`, `vServ`, `cTribNac`, `cNBS`) e exige que o tomador tenha CPF ou CNPJ. A emissão só ocorre com a variável `EMITIR_REAL=1` no ambiente (ligada pela flag `--real` do CLI), porque a emissão em produção é irreversível — só se corrige por substituição, dentro do prazo do município. O arquivo `nota-exemplo.json` serve de modelo de preenchimento. Após a emissão bem-sucedida, o script registra a venda e a nota no banco local (`upsertVenda`, `registrarNota`) e imprime a chave de acesso de 50 dígitos, com fallback para localizar essa chave no XML autorizado mais recente quando a biblioteca não a devolve no retorno.

## Consequências

### Positivas

- Nenhum dado de cliente entra no código-fonte nem no histórico do git.
- A mesma rotina serve para qualquer tomador, sem precisar editar ou duplicar scripts.
- O JSON fica revisável — a operadora pode conferir os dados da nota antes de rodar o comando com `--real`.

### Negativas / custo aceito

- O JSON é entrada não tipada em tempo de compilação: a validação de campos obrigatórios e do CPF/CNPJ do tomador acontece em runtime, dentro da função `carregar`.
- Erro de digitação em um código fiscal (`cTribNac`, `cNBS`) só é detectado por essas validações explícitas, não pelo compilador.

## Alternativas consideradas

### Flags de linha de comando para cada campo — rejeitada

Uma nota tem mais de dez campos, incluindo o endereço aninhado do tomador — inviável de expressar como uma sequência de flags sem reconstruir, na prática, uma sintaxe própria de estrutura de dados.

### Formulário no painel web — rejeitada por ora

É o próximo passo natural de evolução, mas depende do painel já existir e funcionar; não deveria bloquear a emissão avulsa disponível hoje via CLI.

### Manter um script por cliente — rejeitada

Era exatamente o problema do repositório de origem: dado de terceiro hardcoded, impossível de abrir para o fork e custoso de manter a cada novo tomador.
