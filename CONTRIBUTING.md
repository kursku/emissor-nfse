# Contribuindo

Este projeto emite documentos fiscais oficiais. Um erro de código aqui não é
só um bug — pode virar uma nota fiscal incorreta, que só se corrige por
cancelamento ou substituição, dentro do prazo que a prefeitura permitir. As
regras abaixo existem por causa disso, não por formalidade.

## Como rodar

```
npm install
npm run check
```

`npm run check` roda o typecheck (`tsc --noEmit`) seguido dos testes
(`node --import tsx --test`). É o mesmo comando que o hook de pre-commit
executa — se `npm run check` passa localmente, o commit não vai travar por
esse motivo.

Requisitos: Node.js 24 ou superior (o projeto usa `node:sqlite`, módulo
nativo do Node ainda experimental). Testado apenas em Windows; deve
funcionar em Linux/macOS, mas isso não foi verificado.

## O que o pre-commit hook faz

`.githooks/pre-commit` roda `npm run check` antes de qualquer commit e
recusa o commit se o typecheck ou os testes falharem. O hook é ativado pelo
script `prepare` do `package.json` (`git config core.hooksPath .githooks`),
que roda automaticamente depois do `npm install`.

Em emergência, dá para pular o hook com `git commit --no-verify` — mas
conserte o que falhou logo em seguida. Não deixe o `check` quebrado na
branch principal.

## Convenção de commits

[Conventional Commits](https://www.conventionalcommits.org/), em inglês:

```
<tipo>(<escopo opcional>): <resumo curto>

<corpo opcional — explica o porquê, não o quê>
```

- Tipos: `feat`, `fix`, `chore`, `refactor`, `style`, `test`, `docs`.
- Resumo em minúsculo, modo imperativo ("add", não "added" nem "adds").
- Sem ponto final no resumo.
- Resumo com menos de 72 caracteres.
- Use o corpo só quando o motivo da mudança precisar de explicação.

## Branch e pull request

Trabalhe em branch, nunca direto na `main`. O nome segue o tipo principal da
mudança, com os mesmos tipos da convenção de commits acima: `feat/`, `fix/`,
`chore/`, `refactor/`, `style/`, `test/`, `docs/`.

Abrir pull request não é formalidade aqui: o [CodeRabbit](https://coderabbit.ai)
revisa cada PR e só age em PR, nunca em push direto. A configuração está em
`.coderabbit.yaml`, com instruções específicas para os arquivos de código
fiscal (`montar-dps.ts`, `validacoes.mjs`), para as integrações e para os
testes.

A revisão dele é conselho, não portão. O que bloqueia de fato é o hook de
pre-commit e o CI, ambos rodando `npm run check`.

## Testes: o seam puro é `montar-dps.ts`

`montar-dps.ts` monta a DPS (Declaração de Prestação de Serviços) a partir
de funções puras, sem depender de `.env`, certificado ou rede — é por isso
que é testável sem uma configuração fiscal real carregada (ver ADR-0001).
`montar-dps.test.ts` testa essas funções com `node:test`, sem framework
externo.

Regra dura para esses testes: os valores esperados vêm de uma fonte
independente (o layout oficial da DPS, ou uma nota já aceita pela SEFIN
Nacional), **nunca recalculados do mesmo jeito que o código os calcula**. Um
teste que reimplementa a mesma fórmula do código para comparar contra ela
mesma passa por construção e não prova nada. Ao adicionar um teste novo
nesse arquivo, confirme o valor esperado contra o layout ou uma DPS real
antes de escrevê-lo — não contra o que o código imprime.

Os demais arquivos `*.test.mjs` seguem o mesmo padrão: `node:test`, sem
dependência de framework externo de testes.

## Propondo mudança em código fiscal

Qualquer mudança que toque campos fiscais — códigos de tributação
(`cTribNac`, `cNBS`), regime tributário, cálculo do percentual da Lei da
Transparência, montagem da DPS, ou qualquer coisa que afete o conteúdo de
uma nota emitida — **abra uma issue antes de escrever código**. Um erro
fiscal tem consequência legal para quem opera o sistema, não só um bug para
corrigir depois. Descreva na issue qual campo muda, por quê, e como foi
confirmado (fonte: layout oficial, contador, ou nota aceita pela SEFIN).

## ADRs

Decisões difíceis de reverter ficam registradas em `docs/adr/`, no formato
MADR. Antes de propor uma mudança estrutural, confira se já existe um ADR
sobre o assunto. Se a sua mudança contraria uma decisão registrada, diga
isso explicitamente na proposta (PR ou issue) e explique por que a decisão
anterior deixou de se aplicar — não contorne um ADR em silêncio.
