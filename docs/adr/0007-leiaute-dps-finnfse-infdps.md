# 0007 — Leiaute novo da DPS com `finNFSe` em `infDPS`

- Status: aceita
- Data: 2026-10-22

## Contexto e evidencia

O ambiente de Produção Restrita passou a disponibilizar em 20/10/2026 o
release 1 das evoluções da NT 009. O comunicado oficial informa que essas
alterações ainda nao estao em producao, que a virada ocorrerá em 01/12/2026 e
que o leiaute anterior permanece até 30/11/2026:

- [comunicado CGNFS-e de 20/10/2026](https://www.gov.br/nfse/pt-br/noticias/cgnfs-e-informa-disponibilizadas-no-ambiente-de-testes-o-release-1-das-evolucoes-da-nota-tecnica-009)
- [documentacao de Producao Restrita e pacote XSD de 20/10/2026](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita)
- [Nota Tecnica 009 v1.01](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/nota-tecnica-009-se-cgnfs-e-v-1-01.pdf)

No pacote oficial `NFSe-ESQUEMAS_XSD-PRODREST-v1.01-20261020.zip`, `TCInfDPS`
tem a sequencia `tpEmit`, `cMotivoEmisTI` opcional, `finNFSe` obrigatorio,
`chNFSeRej` opcional e `cLocEmi`. `TSRTCFinNFSe` aceita `0` neste release.
`TCRTCInfoIBSCBS` nao contem `finNFSe`; portanto o campo foi removido desse
grupo. O mesmo release reposiciona `cNBS` antes de `xDescServ` e `CST`/
`cClassTrib` diretamente em `trib`, conforme o comunicado.

Hashes SHA-256 conferidos contra o ZIP oficial:

| XSD | SHA-256 |
| --- | --- |
| `CNC_v1.00.xsd` | `7032188BB6F137D52B16512583B739A361E6B1434C42CB539A29B8EFA32F8321` |
| `DPS_v1.01.xsd` | `FE45E5250A48E519ABA89FC6A472863B8E602ED957778FB64692804933A00D0C` |
| `evento_v1.01.xsd` | `986D0A1C4D27454F712169849AA7C2380AAA4560BD9C920E0FF03BA6599AE28B` |
| `NFSe_v1.01.xsd` | `AF0BD2D8C50ACBA3D9C3F3F515426ECA083B3F66E3211CE8DD48A7CF101818B8` |
| `pedRegEvento_v1.01.xsd` | `E90B6816D29CCA0BD5ED8F86AD98D3B7B0D8BBFC11A7583E6FF8F98170FD4009` |
| `tiposCnc_v1.00.xsd` | `AF606B7317824FA8FA7AD8E44BAC2AD8530CD5D162EBCDEC647205473C41D525` |
| `tiposComplexos_v1.01.xsd` | `4F66F7C15BD3B05B3A16CBE5FA671B90C10E4C9C74276038730BE1C8C794B721` |
| `tiposEventos_v1.01.xsd` | `1B32BEA21089DC232D78B62D805E9C07382F440D4E0EA2CB3FB6B82EBDE68C11` |
| `tiposSimples_v1.01.xsd` | `562E326724F85CD7C41176D35E67C542376784D4C950EC1719704D480A8AF226` |
| `xmldsig-core-schema.xsd` | `8C9792A056AEDCADFC95BF16F2D7448A35DA40DF71533E20AEA37D0329980C48` |

## Decisao

Usar sempre o leiaute novo e aplicar um patch local como ponte até a correção
upstream. O patch fica restrito a `@nfewizard/nfse@1.0.7` nos bundles runtime
`dist/index.cjs` e `dist/index.mjs`, e aos três XSDs alterados de
`@nfewizard/shared@1.1.7`. Nos bundles, `normalizarServico` segue a ordem
`cTribNac, cTribMun?, cNBS?, cIntContrib?, xDescServ`, e um marcador exportado
identifica o bundle corrigido em runtime. A aplicação é explícita com
`npm run patch:apply` depois de `npm ci`; em máquinas sem Java, usa-se
`npm ci --ignore-scripts`, `npm rebuild esbuild libxmljs2` e então
`npm run patch:apply`. Não depende de `postinstall`.

O emissor preenche somente `finNFSe = 0` para NFS-e regular. `cMotivoEmisTI`
nao entra em `EmissaoInput`. Os tipos antigos de `@nfewizard/types` nao sao
patchados: `LayoutDPSNovo`, em `src/montar-dps.ts`, declara localmente o campo
novo e remove `finNFSe` do tipo local de `IBSCBS`, com conversao na fronteira
da biblioteca.

`DATA_IMPLANTACAO_NOVO_LEIAUTE = '2026-12-01'`, em `src/ambiente.mjs` e
reexportada por `src/montar-dps.ts`, é a constante normativa usada pela guarda de
ambiente. `NFSE_AMBIENTE=1` é recusado antes dessa data, com mensagem clara,
antes de abrir a fila e antes do envio real; `NFSE_AMBIENTE=2` continua aceito.
O painel não importa o emissor para carregar `/api/defaults`, e os caminhos
reais do painel e da avulsa usam a mesma guarda. O emissor também recusa um
bundle sem o marcador do patch antes do preflight. Não há modo duplo.

## Consequencias

- A conferência local usa os XSDs oficiais de 20/10/2026 e reprova DPS sem
  `finNFSe` em `infDPS`.
- A normalização patched emite `finNFSe` na posição nova e não o emite em
  `IBSCBS`; também acompanha a ordem de `cServ` e os reposicionamentos de
  `cNBS`, `CST` e `cClassTrib` exigidos pelo mesmo release.
- A autorização em Produção Restrita continua sendo validação humana após o
  merge; este worker não executa emissão, servidor real ou integração externa.
- O rascunho para o mantenedor está em `UPSTREAM-ISSUE.md` e não faz parte do
  commit.
