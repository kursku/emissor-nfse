# Higienização — promoção deste staging para o fork público

**Objetivo:** garantir que nenhum dado real do negócio, de clientes ou de
produtos vaze deste repo (`nickgitrabbit/emissor-nfse`, staging privado) para
`kursku/emissor-nfse` (público, opensource).

Diferente do fork único de um cliente específico (ver
`nota-fiscal/22-plano-higienizacao-fork.md`), aqui não há um "momento do
fork" — este repo já nasceu parametrizado e o desenvolvimento acontece direto
nele. O risco não é "vazar ao copiar uma vez", é "vazar a cada commit novo".
Este documento é o checklist repetido a cada promoção `main` deste repo para
`kursku/emissor-nfse`.

## 1. Por que isso importa aqui

Este código evoluiu a partir do `nota-fiscal` (o emissor real usado em
produção), mas os dois já divergiram em estrutura. O que continua igual é o risco: quem
mexe nos dois é a mesma pessoa, no mesmo teclado, e um `git add .` desatento
carrega dado real pro repo errado.

## 2. Classes de vazamento (lições já confirmadas)

| Classe | Exemplo já flagrado | Por que passa em grep simples |
|---|---|---|
| Identificador | CNPJ, IM, código IBGE, nome/senha de certificado | Só passa se o grep for case-insensitive e cobrir todas as variações de formatação |
| Dado de negócio | `seed-produtos.mjs` com nome real de produto e de workshop (achado em 2026-08-08, arquivo untracked, nunca chegou a subir) | Nome de produto/cliente não contém CNPJ nem domínio de e-mail — nenhum grep por identificador acha isso |
| Título/texto de UI | `painel.html` com nome da empresa e "Producao Real" no fork de um cliente | Grep case-sensitive não pega maiúsculas |
| Fixture de teste plausível demais | Endereço de teste usando "Piracicaba" (cidade real do prestador) em `endereco-lastlink.test.ts` | Parece exemplo genérico, mas coincide com dado real — risco baixo, mas cumulativo com outros sinais |
| Segredo em nome de arquivo | Senha do certificado embutida no nome do `.p12` (achado no fork de um cliente) | Grep de conteúdo não olha nome de arquivo |

## 3. Checklist antes de promover `main` para `kursku/emissor-nfse`

Ordem importa — a leitura manual vem antes do grep, não depois:

1. **Ler integralmente** todo arquivo que carrega *dados*, não só lógica:
   seeds (`seed-*.mjs`), constantes tipo `DEFAULTS`/`EXEMPLO`, fixtures
   `*.json`, títulos e textos de `painel.html`, qualquer array/objeto literal
   de strings.
2. **Grep case-insensitive** dos identificadores conhecidos:
   ```
   <nome da empresa/workspace>|<nomes de clientes conhecidos>|<sobrenome do
   titular>|@gmail|<marcas/produtos próprios>|
   <CNPJ do prestador>|<IM>|<código IBGE>
   ```
3. **Grep de termos de negócio** — lista viva, atualizar a cada achado novo:
   ```
   <nomes de curso/produto/workshop conhecidos>
   ```
4. **Grep de strings longas em PT-BR** dentro de literais (aspas simples,
   duplas ou crases):
   ```
   ["'`][A-Za-zÀ-ú][^"'`]{25,}["'`]
   ```
   Não substitui os passos 1 e 2 — concatenação e template strings escapam
   de qualquer regex.
5. **Conferir `.gitignore`** — todo arquivo local-only (estado operacional,
   seed com dado real, script de depuração pessoal) precisa estar listado
   *antes* do primeiro commit que o cria, não depois. Ver seção 4.
6. **`npm run check`** limpo (typecheck + testes) antes de empurrar. Se
   falhar só localmente por incompatibilidade de ambiente (ver seção 5) e o
   CI do GitHub Actions já estiver verde no commit equivalente, isso não
   bloqueia — mas documentar a causa no commit.

## 4. `.gitignore` — lista viva de arquivos local-only

Motivo de cada entrada, para não remover por engano:

```
ESTADO.md          # estado operacional com caminho de máquina
nota-real.json     # nota real de teste, não fixture
check-end.cjs      # script de depuração pessoal
colunas-xlsx.mjs   # idem
estado-notas.cjs   # idem
formato-endereco.mjs # idem
ler-xlsx.cjs       # idem
preparar-nota.mjs  # idem
seed-produtos.mjs  # nomes reais de produto/cliente (achado 2026-08-08)
```

Ao criar um script ou arquivo de dado novo para uso próprio, a pergunta é
"isso teria erro de compilação/teste sem o dado real dentro?" — se sim, é
fixture (pode subir); se o dado só existe porque é o meu negócio de verdade,
vai para o `.gitignore` antes do primeiro `git add`.

## 5. Gotcha de ambiente — não confundir com regressão de código

Node muito recente (nesta máquina, v26) pode não ter binário pré-compilado
para dependências nativas (`libxmljs2`, via `nan`, usa API do V8 já removida
no Node 26). Isso quebra `npm test` localmente sem ter relação com o commit.

- **Fonte de verdade:** o CI do GitHub Actions (roda em Node LTS, Windows e
  Ubuntu). Se ele está verde no commit, a suíte está validada.
- **Para rodar localmente mesmo assim:** usar uma versão LTS do Node
  (ex.: 22.x) só para esse comando, sem trocar a instalação global — ver
  histórico de 2026-08-08 para o procedimento (Node portátil em pasta
  temporária, `npm rebuild` das dependências nativas, depois `npm run check`).
- Nunca usar `--no-verify` para pular o hook de pre-commit só por causa
  disso sem antes confirmar que o CI upstream cobre o mesmo commit.

## 6. Cadência

Não promover a cada commit. Acumular um pacote coerente de mudanças
validadas no staging (`nickgitrabbit`, histórico completo) e promover em
lote para o público (`kursku`, histórico limpo/squash quando fizer sentido).
