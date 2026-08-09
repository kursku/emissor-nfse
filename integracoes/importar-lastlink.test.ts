/**
 * Testes dos helpers puros de importar-lastlink.ts: parse de campos brutos da
 * planilha (str/parseNum/excelSerialToIso), classificação de fila e
 * normalização de venda. Não exercita main() — importar este módulo não abre
 * xlsx nem toca o banco (guarda isMain).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  str,
  parseNum,
  excelSerialToIso,
  classificarFila,
  normalizarVenda,
} from "./importar-lastlink.js";
import type { RawRow } from "./importar-lastlink.js";

const HOJE = new Date("2026-06-15T00:00:00Z");
const PRODUTOS = new Set(["Produto Exemplo"]);

function rowBase(overrides: Partial<RawRow> = {}): RawRow {
  return {
    "Identificador da venda": "venda-uuid-1",
    "Status da venda": "Aprovada",
    "Produto principal": "Produto Exemplo",
    "Comissão total de coprodutores": 100,
    "Documento do membro": "11444777000161",
    "Nome/Razão social do membro": "EMPRESA EXEMPLO LTDA",
    ...overrides,
  };
}

// ─── str / parseNum / excelSerialToIso ────────────────────────────────────────

test("str remove espacos e trata null/undefined como vazio", () => {
  assert.equal(str("  Cliente Exemplo  "), "Cliente Exemplo");
  assert.equal(str(null), "");
  assert.equal(str(undefined), "");
  assert.equal(str(123), "123");
});

test("parseNum devolve 0 para valor nao numerico", () => {
  assert.equal(parseNum("1234.56"), 1234.56);
  assert.equal(parseNum("abc"), 0);
  assert.equal(parseNum(undefined), 0);
});

test("excelSerialToIso converte serial Excel para ISO AAAA-MM-DD", () => {
  assert.equal(excelSerialToIso(45718), "2025-03-02");
  assert.equal(excelSerialToIso("45718"), "2025-03-02"); // aceita string
  assert.equal(excelSerialToIso(45718.5), "2025-03-02"); // fracao = hora, ignorada
});

test("excelSerialToIso devolve undefined para serial zero, negativo ou invalido", () => {
  assert.equal(excelSerialToIso(0), undefined);
  assert.equal(excelSerialToIso(-5), undefined);
  assert.equal(excelSerialToIso("nao e data"), undefined);
  assert.equal(excelSerialToIso(undefined), undefined);
});

// ─── classificarFila ──────────────────────────────────────────────────────────

test("classificarFila manda pra excecao quando estrangeiro", () => {
  const fila = classificarFila(
    rowBase({ "Sou Estrangeiro": "Sim" }),
    HOJE,
    true,
    PRODUTOS,
  );
  assert.equal(fila, "excecao");
});

test("classificarFila manda pra excecao quando produto nao esta mapeado", () => {
  const fila = classificarFila(
    rowBase({ "Produto principal": "Produto Desconhecido" }),
    HOJE,
    true,
    PRODUTOS,
  );
  assert.equal(fila, "excecao");
});

test("classificarFila manda pra excecao quando comissao e zero ou negativa", () => {
  assert.equal(
    classificarFila(rowBase({ "Comissão total de coprodutores": 0 }), HOJE, true, PRODUTOS),
    "excecao",
  );
  assert.equal(
    classificarFila(rowBase({ "Comissão total de coprodutores": -10 }), HOJE, true, PRODUTOS),
    "excecao",
  );
});

test("classificarFila manda pra pendente_cadastro quando falta documento ou nome", () => {
  assert.equal(
    classificarFila(rowBase({ "Documento do membro": "" }), HOJE, true, PRODUTOS),
    "pendente_cadastro",
  );
  assert.equal(
    classificarFila(rowBase({ "Nome/Razão social do membro": "" }), HOJE, true, PRODUTOS),
    "pendente_cadastro",
  );
});

test("classificarFila manda pra aguardando_garantia quando expiracao ainda nao passou", () => {
  // serial 46600 = data no futuro em relacao a HOJE (2026-06-15)
  const fila = classificarFila(
    rowBase({ "Data da expiração": 46600 }),
    HOJE,
    true,
    PRODUTOS,
  );
  assert.equal(fila, "aguardando_garantia");
});

test("classificarFila manda pra pronta_sem_endereco quando endereco esta incompleto", () => {
  const fila = classificarFila(rowBase(), HOJE, false, PRODUTOS);
  assert.equal(fila, "pronta_sem_endereco");
});

test("classificarFila manda pra pronta quando tudo esta ok", () => {
  const fila = classificarFila(rowBase(), HOJE, true, PRODUTOS);
  assert.equal(fila, "pronta");
});

test("classificarFila prioriza excecao sobre pendente_cadastro", () => {
  const fila = classificarFila(
    rowBase({ "Sou Estrangeiro": "Sim", "Documento do membro": "" }),
    HOJE,
    true,
    PRODUTOS,
  );
  assert.equal(fila, "excecao");
});

// ─── normalizarVenda ──────────────────────────────────────────────────────────

test("normalizarVenda usa a comissao do coprodutor como valor da nota, nao o valor bruto", () => {
  const venda = normalizarVenda(
    rowBase({ "Comissão total de coprodutores": 150, "Valor da venda": 500 }),
    HOJE,
    null,
    null,
    PRODUTOS,
  );
  assert.equal(venda.valor, 150);
  assert.equal(venda.valor_bruto, 500);
});

test("normalizarVenda usa o status inicial igual a fila calculada", () => {
  const venda = normalizarVenda(rowBase(), HOJE, null, null, PRODUTOS);
  assert.equal(venda.status, venda.fila);
  assert.equal(venda.fila, "pronta_sem_endereco"); // sem endereco (end=null)
});

test("normalizarVenda inclui cmun e campos de endereco so quando ambos existem", () => {
  const end = {
    xLgr: "Rua Exemplo",
    nro: "100",
    xBairro: "Centro",
    CEP: "13400000",
    cidade: "Cidade Exemplo",
    uf: "SP",
  };
  const venda = normalizarVenda(rowBase(), HOJE, end, "3509502", PRODUTOS);
  assert.equal(venda.cmun, "3509502");
  assert.equal(venda.rua, "Rua Exemplo");
  assert.equal(venda.fila, "pronta");
});
