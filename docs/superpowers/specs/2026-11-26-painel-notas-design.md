# Painel: navegação por seções, aba Fechamento e conferência do DAS

- Status: proposta (revisão do Nick pendente)
- Data: 2026-11-26
- Origem: brainstorming de 26/11, protótipo descartável na branch `prototype/painel-notas` (`d5d2598`) e crítica de design (`impeccable critique`, notas A 26/40, B 27/40, C 30/40).

## Problema

O painel (`src/painel/painel.html` + `src/painel/server.ts`) mostra só **Vendas** e a **Emissão manual**. Não há como ver as **Notas** já emitidas. Fechar o mês hoje é conferir à mão o total das notas de uma **competência** contra a guia do DAS (Simples Nacional) e mandar PDFs e XMLs ao contador. A crítica do protótipo mostrou que cada variante atendia uma tarefa e escondia as outras. A também tinha um resumo da fila que dizia "0 com erro" com dezenas de vendas pedindo atenção.

## Objetivo

Um painel com três seções, numa estrutura só:

1. **Fechamento:** consultar as Notas de uma competência, o total e conferir o DAS. Só leitura.
2. **Vendas:** acompanhar a fila, com um único número de "precisam de atenção" sempre visível.
3. **Emissão manual:** o formulário que já existe, sem mudança de comportamento.

E um aviso de ambiente e simulação, fixo e igual em todas as seções.

## Fora de escopo (próximos PRs)

- Cor exclusiva de "atenção" e redução dos contadores zerados (P2 da crítica).
- Detalhe enxuto: descrição recolhida e chave em grupos (P2).
- Exportar o mês em pacote para o contador (PDFs, XMLs e total).
- Cálculo automático da alíquota do Simples pelo faturamento de 12 meses (RBT12).
- Nota cancelada ou substituída. Hoje o banco não registra cancelamento. A tela não infere esse estado e mostra uma nota de rodapé dizendo que o total é das notas autorizadas registradas.
- Layout para celular. O alvo é desktop, de 1024 px para cima.

## Histórias (checáveis)

1. Abro o painel e caio em **Fechamento**, na competência mais recente que tem Nota.
2. Troco de competência com ‹ ›, com um seletor ou com as teclas `[` e `]`. A URL guarda a competência (`?competencia=AAAA-MM`), então recarregar mantém o mês.
3. Vejo o **total da competência** em destaque e a quantidade de Notas.
4. Vejo a tabela de Notas no estilo livro-razão: nº, data de emissão, tomador, documento mascarado, valor e ações PDF/XML. O total aparece uma vez só, no rodapé da tabela; o destaque do topo é o mesmo número.
5. Clico numa linha, ou aperto Enter/Espaço com ela em foco, e ela expande mostrando a chave (com botão copiar), o nDPS, a competência e a Venda de origem. A linha é um `<button>` dentro da célula, não um `tr[tabindex]`.
6. **Conferência do DAS:** informo a alíquota efetiva do mês (%) e o valor da guia (R$). A tela mostra o DAS esperado (total × alíquota) e "confere" ou "diverge em R$ X". Tolerância: R$ 0,05, porque a guia arredonda. Nada é salvo no servidor. A alíquota fica no `localStorage`, por competência, só para não redigitar.
7. Se existe XML autorizado em `<outputDir>/autorizacao/` sem linha em `notas` (Nota órfã), a competência mostra um alerta "N Nota(s) autorizada(s) fora do banco, não somada(s)", com PDF e XML. A Nota órfã **não entra** no total.
8. Uma Nota sem XML local mostra a competência como "estimada", pelo mês de `emitida_em`, e o PDF fica indisponível com o motivo escrito.
9. No menu lateral, o item **Vendas** tem um selo com o número de "precisam de atenção". Ele soma os status `pendente_cadastro`, `excecao`, `erro` e `a_verificar` e reaparece a cada carregamento. Com 0, o selo some.
10. A seção **Vendas** traz a faixa de status (contadores por status, clicáveis como filtro) e a tabela atual de vendas, com filtros, paginação e Retry iguais aos de hoje.
11. O **aviso de ambiente** fica fixo no topo, em todas as seções. Ele diz "PRODUÇÃO (NFSE_AMBIENTE=1)" ou "HOMOLOGAÇÃO/PRODUÇÃO RESTRITA (NFSE_AMBIENTE=2)", e ainda "simulação" quando `EMITIR_REAL` não está ligado. Reaproveita o texto de `mensagemModoReal`, de `src/ambiente.mjs`.
12. Tudo navegável por teclado, com foco visível em todo controle, contraste AA, nenhum alvo de clique menor que 24×24 px e nenhuma rolagem horizontal a 1024 px.

## Desenho

### Servidor (`src/painel/server.ts`)

Rotas novas, todas só leitura:

- `GET /api/notas/competencias`: a lista `[{competencia, total, quantidade, estimada}]`, com a mais recente primeiro.
- `GET /api/notas?competencia=AAAA-MM`: devolve `{competencia, notas: [...], total, quantidade, orfas: [...]}`.
  - Cada Nota: `{nNFSe, ndps, chave, emitidaEm, competencia, competenciaEstimada, tomador, documentoMascarado, valor, idVenda, temXml, temPdf}`.
  - Valor e tomador saem do XML autorizado quando ele existe (é a fonte fiscal). Sem XML, saem da Venda.
- `GET /api/notas/:chave/xml` e `GET /api/notas/:chave/pdf`:
  - a chave precisa ter 50 dígitos, ou a resposta é 400;
  - os arquivos são resolvidos só dentro de `config.outputDir`, sem montar caminho a partir de entrada do usuário;
  - o PDF vem do arquivo em cache, se existir. Se não, é gerado **localmente a partir do XML**, com o caminho local do `src/danfse.ts`, sem chamar o ADN.
- O resumo existente (`GET /api/vendas/resumo`) ganha `atencao: number`, a soma descrita na história 9.

A leitura dos XMLs fica num módulo próprio, com função pura testável: `src/notas-locais.ts`, por exemplo, com `lerNotaAutorizada(xml) → campos` e `listarNotas(db, outputDir, competencia)`. O `server.ts` só monta as rotas.

O banco é aberto como já é hoje no painel. Nenhuma rota nova escreve nada.

### Cliente (`src/painel/painel.html`)

- Estrutura: menu lateral com Fechamento, Vendas (com o selo) e Emissão manual, mais a faixa de ambiente fixa no topo. A seção ativa vai na URL (`?secao=`).
- Fechamento:
  - cabeçalho da competência com ‹ ›, o seletor, o total em destaque e a quantidade;
  - o cartão de conferência do DAS;
  - o alerta de órfãs;
  - a tabela livro-razão com as linhas que expandem.
- Vendas: a faixa de status, mais o conteúdo atual da aba Acompanhamento.
- Emissão manual: o conteúdo atual, sem mudança.
- Valores monetários com `Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'})` e números tabulares.
- O id e a chave entram no DOM por `data-*` e `textContent`, nunca por HTML concatenado (a regra do commit de `reenviar`).
- O CSS segue no mesmo arquivo, sem dependência nova e sem etapa de build.

## Testes

- Unidade (`src/notas-locais.test.ts`):
  - extrair os campos do XML autorizado (fixture sintética);
  - competência estimada;
  - Nota órfã detectada e não somada;
  - total por competência;
  - entidades XML decodificadas.
- Servidor (`src/painel/server.test.ts`):
  - as rotas novas devolvem a estrutura esperada sobre um banco temporário com fixtures sintéticas;
  - chave inválida → 400;
  - tentativa de path traversal → 400/404;
  - `atencao` no resumo.
- DAS: uma função pura `conferirDas(total, aliquotaPct, valorGuia)` → `{esperado, diferenca, confere}`, com testes de tolerância e arredondamento. Pode ficar num `.mjs` importado pelo HTML e pelo teste.
- Visual: prints a 1440 px e 1024 px, mais um `impeccable critique` no final. A meta é a nota subir em relação aos 30/40 da variante C.
- Gate: `npm run check` verde e CI verde no Windows e no Ubuntu.

## Riscos

- O repo é público. Fixtures e prints commitados usam só dados sintéticos.
- A alíquota digitada errada dá "diverge" falso. É só leitura, então não causa dano, mas a interface deixa claro que a alíquota é a da guia do mês.
- A geração local do PDF depende do navegador do sistema (`NFSE_DANFSE_BROWSER`). Sem ele, o botão de PDF mostra o erro e oferece o XML.

## Decisões

- O total do mês considera só as Notas registradas no banco. A Nota órfã gera alerta, não soma. É o comportamento que o protótipo validou.
- A alíquota do DAS é manual, por mês, guardada só no navegador. O cálculo automático pelo RBT12 fica para depois.
- O PDF sai só de cache ou é gerado localmente. A tela nunca chama o ADN.
