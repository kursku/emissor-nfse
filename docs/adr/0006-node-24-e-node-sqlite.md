# 0006 — Exigir Node 24 e usar o SQLite embutido

- Status: aceita
- Data: 2026-07-30

## Contexto e problema

O projeto guarda vendas, notas emitidas, o mapa de produtos e os contratos
recorrentes num banco local. A escolha do driver de banco decide o requisito de
instalação para quem vai operar o sistema — e o público-alvo inclui pessoas não
técnicas, em máquinas Windows, sem ambiente de compilação instalado.

O SQLite passou a ser embutido no Node (`node:sqlite`). O módulo continua
marcado como experimental pelo próprio Node, o que faz o runtime imprimir um
aviso em toda execução. A alternativa consagrada, `better-sqlite3`, é um módulo
nativo: precisa ser compilado na instalação ou baixar binário pré-compilado
compatível com a versão exata do Node.

## Decisão

Usar `node:sqlite` e declarar `engines.node >= 24` no `package.json`.

O aviso experimental é aceito como custo. Em troca, `npm install` não compila
nada: não há dependência de Python, de toolchain C++ ou de binário pré-compilado
para a plataforma certa — o modo mais comum de a instalação falhar na máquina de
quem não programa.

## Consequências

### Positivas

- Instalação sem etapa de compilação, que é a principal fonte de falha de setup
  em Windows para usuário não técnico.
- Uma dependência a menos, e nenhuma dependência nativa para atualizar quando a
  versão do Node muda.
- O banco é um arquivo único, copiável e inspecionável com qualquer ferramenta
  de SQLite.

### Negativas / custo aceito

- Node 24 ou superior é obrigatório. Quem está em 20 ou 22 LTS precisa
  atualizar antes de usar.
- O aviso `ExperimentalWarning: SQLite is an experimental feature` aparece a
  cada execução. É ruído, e pode assustar quem não conhece.
- A API pode mudar entre versões do Node enquanto estiver marcada como
  experimental, exigindo ajuste em `store.ts`.

## Alternativas consideradas

### `better-sqlite3` — rejeitada

API estável e madura, sem aviso experimental, e funciona em versões LTS mais
antigas do Node. Rejeitada pelo custo de instalação: é um módulo nativo, e uma
falha de compilação no primeiro `npm install` trava o usuário logo no passo
inicial, antes de qualquer contato com o sistema.

### Banco em arquivo JSON — rejeitada

Dispensaria driver, mas perde consultas, índices e as garantias de escrita
concorrente que o painel e a fila usam. O volume de notas de um prestador
pequeno caberia, mas a perda de integridade referencial entre `vendas` e
`notas` não compensa.

### Postgres ou outro banco servidor — rejeitada

Exigiria instalar e manter um serviço para um sistema que roda na máquina de
uma pessoa. Desproporcional ao problema.
