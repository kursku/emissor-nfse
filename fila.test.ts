/**
 * Testes dos helpers puros de fila-helpers.ts: montarInput (mapeamento Venda
 * -> EmissaoInput) e buscarMapaProduto (lookup em mapa_produtos). Testado via
 * fila-helpers.ts diretamente — importar fila.ts puxa config.ts, que exige
 * NFSE_* no ambiente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { montarInput, buscarMapaProduto } from "./fila-helpers.js";
import { initDb } from "./store.js";
import type { Venda } from "./store.js";

const MAPA = { ctrib_nac: "080201", cnbs: "122051900", xdesc_serv: "Servico de exemplo." };

function vendaBase(overrides: Partial<Venda> = {}): Venda {
  return {
    id_venda: "venda-1",
    nome: "EMPRESA EXEMPLO LTDA",
    valor: 1234.56,
    ...overrides,
  };
}

test("montarInput usa CNPJ quando o documento tem 14 digitos", () => {
  const input = montarInput(vendaBase({ cpf_cnpj: "11.444.777/0001-61" }), MAPA, "7");
  assert.equal(input.tomador.CNPJ, "11444777000161");
  assert.equal("CPF" in input.tomador, false);
});

test("montarInput usa CPF quando o documento tem 11 digitos", () => {
  const input = montarInput(vendaBase({ cpf_cnpj: "111.444.777-35" }), MAPA, "7");
  assert.equal(input.tomador.CPF, "11144477735");
  assert.equal("CNPJ" in input.tomador, false);
});

test("montarInput recusa documento com tamanho invalido", () => {
  assert.throws(
    () => montarInput(vendaBase({ cpf_cnpj: "123" }), MAPA, "7"),
    /Documento inválido para id_venda=venda-1/,
  );
});

test("montarInput inclui endereco so quando todos os campos estao presentes", () => {
  const completo = montarInput(
    vendaBase({
      cpf_cnpj: "11444777000161",
      cmun: "3509502",
      cep: "13400-000",
      rua: "Rua Exemplo",
      numero: "100",
      bairro: "Centro",
    }),
    MAPA,
    "7",
  );
  assert.deepEqual(completo.tomador.end, {
    cMun: "3509502",
    CEP: "13400000",
    xLgr: "Rua Exemplo",
    nro: "100",
    xBairro: "Centro",
  });
});

test("montarInput omite endereco inteiro quando falta qualquer campo", () => {
  const semBairro = montarInput(
    vendaBase({
      cpf_cnpj: "11444777000161",
      cmun: "3509502",
      cep: "13400-000",
      rua: "Rua Exemplo",
      numero: "100",
      // bairro ausente
    }),
    MAPA,
    "7",
  );
  assert.equal("end" in semBairro.tomador, false);
});

test("montarInput inclui email so quando presente na venda", () => {
  const comEmail = montarInput(
    vendaBase({ cpf_cnpj: "11444777000161", email: "cliente@exemplo.com.br" }),
    MAPA,
    "7",
  );
  assert.equal(comEmail.tomador.email, "cliente@exemplo.com.br");

  const semEmail = montarInput(vendaBase({ cpf_cnpj: "11444777000161" }), MAPA, "7");
  assert.equal("email" in semEmail.tomador, false);
});

test("montarInput mapeia nDPS, valor e codigos fiscais do mapa de produto", () => {
  const input = montarInput(
    vendaBase({ cpf_cnpj: "11444777000161", valor: 500 }),
    MAPA,
    "42",
  );
  assert.equal(input.nDPS, "42");
  assert.equal(input.vServ, 500);
  assert.equal(input.xDescServ, MAPA.xdesc_serv);
  assert.equal(input.cTribNac, MAPA.ctrib_nac);
  assert.equal(input.cNBS, MAPA.cnbs);
  assert.equal(input.cIndOp, "100301");
  assert.equal(input.cClassTrib, "000001");
});

test("buscarMapaProduto retorna os codigos fiscais cadastrados", () => {
  const db = initDb(":memory:");
  db.prepare(
    "INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)",
  ).run("produto-teste", "080201", "122051900", "Servico de exemplo.");

  const mapa = buscarMapaProduto(db, "produto-teste");
  assert.deepEqual({ ...mapa }, { ctrib_nac: "080201", cnbs: "122051900", xdesc_serv: "Servico de exemplo." });
});

test("buscarMapaProduto retorna null para produto sem mapeamento", () => {
  const db = initDb(":memory:");
  assert.equal(buscarMapaProduto(db, "produto-desconhecido"), null);
});
