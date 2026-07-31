# 0002 — CLI único por spawn do tsx, sem etapa de build

- Status: aceita
- Data: 2026-07-29

## Contexto e problema

O projeto é TypeScript executado com `tsx`, sem etapa de compilação prévia. A operadora do sistema é uma pessoa não técnica, e os comandos originais eram longos e específicos de shell — por exemplo `npx tsx fila.ts --limite 5`, com a variável `EMITIR_REAL=1` prefixada, cuja sintaxe no PowerShell (`$env:EMITIR_REAL=1; ...`) difere da do Bash. Era preciso um ponto de entrada único, simples de digitar, que funcionasse igual em PowerShell, cmd e shells Unix, sem depender de uma etapa de build.

## Decisão

Um `cli.mjs` foi declarado como `bin` (`nfse`) no `package.json`. Ele roteia subcomandos (`setup`, `check`, `painel`, `fila`, `emitir`, `importar`, `arquivar`) e faz `spawn` do `tsx` local (`node_modules/tsx/dist/cli.mjs`) sobre o script `.ts` correspondente, com `stdio: 'inherit'`. O script `setup.mjs` (assistente de configuração) roda com `node` puro, sem exigir `node_modules`, para funcionar antes mesmo do `npm install`. A flag `--real`, informada em qualquer comando, é filtrada dos argumentos repassados ao script e convertida internamente em `EMITIR_REAL=1` no ambiente do processo filho — uma forma uniforme de ligar o modo de emissão real, igual em PowerShell, cmd e Bash.

## Consequências

### Positivas

- Um único comando (`nfse <comando> [args]`) cobre todos os fluxos, com ajuda embutida (`nfse --help`) e mensagem de erro clara para comando desconhecido ou dependências não instaladas.
- A sintaxe de shell deixa de ser um obstáculo para a operadora: `--real` funciona igual em qualquer terminal.
- `cli.mjs` resolve caminhos a partir de `import.meta.dirname`, então os scripts funcionam de qualquer pasta em que o terminal esteja.

### Negativas / custo aceito

- Custo de um processo extra por comando (o `spawn` do `tsx`).
- `tsx` passa a ser dependência de runtime do produto, não apenas de desenvolvimento.
- Não existe um artefato JavaScript distribuível — rodar o CLI depende de `node_modules` instalado (exceto para `setup`, que roda com `node` puro).

## Alternativas consideradas

### Compilar com `tsc` e apontar `bin` para o build — rejeitada

Introduziria uma etapa de build e um diretório `dist` que sai de sincronia com a fonte a cada mudança, aumentando o atrito de manutenção para um projeto pequeno.

### Usar `commander` ou `yargs` — rejeitada

Seria uma dependência adicional para rotear apenas seis subcomandos; o roteamento manual em `cli.mjs` (um objeto de configuração + `spawn`) já resolve o caso sem biblioteca extra.

### Shims `.cmd`/`.sh` por comando — rejeitada

Multiplicaria arquivos (um shim por sistema operacional por comando) e divergiria entre plataformas — exatamente o problema que a flag `--real` uniforme já resolve dentro de um único `cli.mjs`.
