import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConciliacaoArgs } from "./conciliar.js";

test("conciliar aceita Chave ou rejeitada, nunca os dois", () => {
  assert.deepEqual(parseConciliacaoArgs(["venda-1", "--chave", "1".repeat(50)]), {
    idVenda: "venda-1",
    chave: "1".repeat(50),
  });
  assert.deepEqual(parseConciliacaoArgs(["venda-1", "--rejeitada"]), {
    idVenda: "venda-1",
    rejeitada: true,
  });
  assert.throws(
    () => parseConciliacaoArgs(["venda-1", "--chave", "1".repeat(50), "--rejeitada"]),
    /exatamente uma/i,
  );
});
