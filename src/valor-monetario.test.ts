import { test } from "node:test";
import assert from "node:assert/strict";

import { parseValorMonetario } from "./valor-monetario.js";

test("parseValorMonetario aceita texto pt-BR e número", () => {
  assert.equal(parseValorMonetario("1.234,56"), 1234.56);
  assert.equal(parseValorMonetario("49,90"), 49.9);
  assert.equal(parseValorMonetario(49.9), 49.9);
});

test("parseValorMonetario rejeita texto parcial ou ambíguo", () => {
  for (const valor of ["100abc", "49.90", "1,234.56", "R$ 49,90"]) {
    assert.throws(() => parseValorMonetario(valor), /valor monetário inválido/);
  }
});

test("parseValorMonetario arredonda número para duas casas", () => {
  assert.equal(parseValorMonetario(59.940000000000005), 59.94);
});

test("parseValorMonetario arredonda números igual ao texto pt-BR equivalente", () => {
  for (const [numero, texto, esperado] of [
    [10.075, "10,075", 10.08],
    [1.005, "1,005", 1.01],
    [59.940000000000005, "59,940000000000005", 59.94],
  ] as const) {
    assert.equal(parseValorMonetario(numero), esperado);
    assert.equal(parseValorMonetario(numero), parseValorMonetario(texto));
  }
});
