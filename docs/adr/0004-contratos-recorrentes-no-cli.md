# 0004 — Contratos recorrentes como subcomando do CLI

- Status: aceita
- Data: 2026-07-30

## Contexto e problema

A feature de contratos recorrentes (clientes com fee mensal fixo, que geram uma venda por mês em vez de uma importação avulsa) veio do repositório de origem e existia como um CLI paralelo, acessível apenas por `npx tsx contratos.ts`. Não aparecia no comando `nfse` nem em nenhuma documentação do projeto. Isso contradizia diretamente o ADR-0002, cuja decisão foi que um único comando (`nfse <comando> [args]`) cobre todos os fluxos — a operadora não deveria precisar saber que existe um segundo ponto de entrada, com sintaxe própria, para uma parte do sistema.

## Decisão

Registrar `contratos.ts` como subcomando `nfse contratos <subcomando>` (`criar`, `listar`, `desativar`, `gerar`) no roteamento do `cli.mjs`, e documentar a feature no README e no glossário de domínio, em vez de removê-la. A feature atende um caso de uso real — cliente com fee mensal recorrente — e funciona; o problema era exclusivamente de descoberta e consistência de interface, não de utilidade.

## Consequências

### Positivas

- Um único comando (`nfse`) volta a cobrir todos os fluxos, inclusive contratos recorrentes, restaurando a garantia do ADR-0002.
- A operadora não precisa saber que `contratos.ts` existe como arquivo nem lembrar a sintaxe de `npx tsx`.
- A feature de contratos passa a ter a mesma cobertura de documentação (README, glossário) que o resto do sistema.

### Negativas / custo aceito

- `store.ts` passa a ter duas responsabilidades declaradas: o pipeline de emissão (vendas, notas, mapa de produtos) e os contratos recorrentes. É o candidato natural a divisão em dois módulos se a feature de contratos crescer além do que é hoje.

## Alternativas consideradas

### Remover a feature do fork — rejeitada

Contratos recorrentes atende um caso de uso real (cliente com fee mensal) e a implementação já funciona. Removê-la só para simplificar a superfície do CLI jogaria fora uma feature funcional em vez de simplesmente documentá-la e roteá-la corretamente.
