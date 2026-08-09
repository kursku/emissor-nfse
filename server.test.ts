/**
 * Teste do helper puro de mascara.ts, usado por server.ts para mascarar
 * CPF/CNPJ nas respostas do painel (/api/vendas nunca devolve o documento
 * completo). Testado via mascara.ts diretamente — importar server.ts puxa
 * emissor.ts/config.ts, que exigem NFSE_* no ambiente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mascaraDoc } from "./mascara.js";

test("mascaraDoc mostra so os 3 primeiros e 2 ultimos digitos de um CPF", () => {
  assert.equal(mascaraDoc("111.444.777-35"), "111...35");
});

test("mascaraDoc mostra so os 3 primeiros e 2 ultimos digitos de um CNPJ", () => {
  assert.equal(mascaraDoc("11.444.777/0001-61"), "114...61");
});

test("mascaraDoc devolve vazio para documento ausente", () => {
  assert.equal(mascaraDoc(undefined), "");
  assert.equal(mascaraDoc(null), "");
  assert.equal(mascaraDoc(""), "");
});

test("mascaraDoc nao mascara documento curto demais (menos de 5 digitos)", () => {
  assert.equal(mascaraDoc("1234"), "1234");
});
