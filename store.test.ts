import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb, upsertVenda, listVendas, marcarStatus } from "./store.js";
import type { Venda } from "./store.js";

function vendaBase(id: string): Venda {
  return {
    id_venda: id,
    fonte: "lastlink",
    produto: "produto-teste",
    valor: 100,
    fila: "pronta",
    status: "pronta",
  };
}

function porId(id: string): Venda {
  const v = listVendas({ id_venda: id })[0];
  assert.ok(v, `venda ${id} deveria existir`);
  return v;
}

test("upsertVenda insere uma venda nova", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-1"));
  const v = porId("venda-1");
  assert.equal(v.status, "pronta");
  assert.equal(v.fila, "pronta");
});

test("upsertVenda repetido atualiza dados cadastrais sem duplicar", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-1"));
  upsertVenda({ ...vendaBase("venda-1"), nome: "Cliente Exemplo" });
  assert.equal(listVendas({ id_venda: "venda-1" }).length, 1);
  assert.equal(porId("venda-1").nome, "Cliente Exemplo");
});

test("upsertVenda NAO regride fila/status de uma venda emitida", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-1"));
  marcarStatus("venda-1", "emitida");
  assert.equal(porId("venda-1").status, "emitida");

  // reimportação da mesma venda (ex.: nova rodada de import) não pode voltar
  // o status para 'pronta' — a nota já existe.
  upsertVenda(vendaBase("venda-1"));
  const v = porId("venda-1");
  assert.equal(v.status, "emitida");
  assert.equal(v.fila, "pronta"); // fila é congelada no valor de quando emitiu
});

test("upsertVenda NAO regride fila/status de uma venda simulada", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-1"));
  marcarStatus("venda-1", "simulada");
  upsertVenda({ ...vendaBase("venda-1"), fila: "excecao", status: "excecao" });
  assert.equal(porId("venda-1").status, "simulada");
});

test("marcarStatus NUNCA regride uma venda ja emitida, mesmo pedindo outro status", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-1"));
  marcarStatus("venda-1", "emitida");
  marcarStatus("venda-1", "erro", "tentativa indevida de reprocessar");
  const v = porId("venda-1");
  assert.equal(v.status, "emitida");
  // erro ainda é registrado mesmo sem mudar o status — útil para auditoria
  assert.equal(v.erro, "tentativa indevida de reprocessar");
});

test("marcarStatus mapeia cada status para a fila correta", () => {
  initDb(":memory:");
  const casos: Array<[string, string]> = [
    ["pendente_cadastro", "pendente_cadastro"],
    ["aguardando_garantia", "aguardando_garantia"],
    ["excecao", "excecao"],
    ["pronta_sem_endereco", "pronta_sem_endereco"],
    ["erro", "pronta"],
  ];
  for (const [status, filaEsperada] of casos) {
    upsertVenda(vendaBase(`venda-${status}`));
    marcarStatus(`venda-${status}`, status as Venda["status"]);
    assert.equal(porId(`venda-${status}`).fila, filaEsperada, `status ${status}`);
  }
});
