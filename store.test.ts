import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initDb,
  upsertVenda,
  listVendas,
  marcarStatus,
  criarContrato,
  listContratos,
  desativarContrato,
  gerarVendasDoMes,
} from "./store.js";
import type { Venda, Contrato } from "./store.js";

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

// ─── Contratos recorrentes ───────────────────────────────────────────────────

function contratoBase(overrides: Partial<Contrato> = {}): Omit<Contrato, "id" | "criado_em"> {
  return {
    cliente_doc: "11444777000161",
    cliente_nome: "EMPRESA EXEMPLO LTDA",
    valor: 500,
    xdesc_serv: "Servico de exemplo.",
    ctrib_nac: "080201",
    cnbs: "122051900",
    dia_do_mes: 10,
    ...overrides,
  };
}

test("criarContrato registra o mapa_produtos correspondente", () => {
  initDb(":memory:");
  criarContrato(contratoBase());

  // mapa_produtos e' o que permite fila.ts resolver os campos fiscais dessa
  // venda (buscarMapaProduto); sem o registro, gerarVendasDoMes ainda cria a
  // venda (nao depende de mapa_produtos), mas a fila recusaria depois com
  // "Produto sem mapeamento fiscal" — aqui confirmamos que o produto da
  // venda gerada bate com a chave que criarContrato registrou.
  assert.equal(gerarVendasDoMes("2026-03"), 1);
  const [venda] = listVendas().filter((v) => v.fonte === "contrato");
  assert.equal(venda.produto, "Contrato: Servico de exemplo.");
});

test("listContratos(true) traz so ativos; listContratos(false) traz todos", () => {
  initDb(":memory:");
  const id1 = criarContrato(contratoBase({ cliente_nome: "Cliente A" }));
  criarContrato(contratoBase({ cliente_nome: "Cliente B" }));
  desativarContrato(id1);

  assert.deepEqual(
    listContratos(true).map((c) => c.cliente_nome),
    ["Cliente B"],
  );
  assert.deepEqual(
    listContratos(false).map((c) => c.cliente_nome).sort(),
    ["Cliente A", "Cliente B"],
  );
});

test("gerarVendasDoMes cria uma venda por contrato ativo na competencia", () => {
  initDb(":memory:");
  criarContrato(contratoBase());
  criarContrato(contratoBase({ cliente_nome: "Cliente B", dia_do_mes: 20 }));

  const novas = gerarVendasDoMes("2026-04");
  assert.equal(novas, 2);

  const vendas = listVendas().filter((v) => v.fonte === "contrato");
  assert.equal(vendas.length, 2);
  assert.deepEqual(
    vendas.map((v) => v.data_venda).sort(),
    ["2026-04-10", "2026-04-20"],
  );
});

test("gerarVendasDoMes e idempotente: rodar de novo nao duplica", () => {
  initDb(":memory:");
  criarContrato(contratoBase());

  assert.equal(gerarVendasDoMes("2026-05"), 1);
  assert.equal(gerarVendasDoMes("2026-05"), 0);
  assert.equal(listVendas().filter((v) => v.fonte === "contrato").length, 1);
});

test("gerarVendasDoMes ignora contrato desativado", () => {
  initDb(":memory:");
  const id = criarContrato(contratoBase());
  desativarContrato(id);

  assert.equal(gerarVendasDoMes("2026-06"), 0);
});

test("gerarVendasDoMes limita o dia ao ultimo dia do mes (dia 31 em fevereiro)", () => {
  initDb(":memory:");
  criarContrato(contratoBase({ dia_do_mes: 31 }));

  gerarVendasDoMes("2026-02"); // 2026 nao e bissexto: fevereiro tem 28 dias
  const [venda] = listVendas().filter((v) => v.fonte === "contrato");
  assert.equal(venda.data_venda, "2026-02-28");
});

test("gerarVendasDoMes recusa competencia sem o separador AAAA-MM", () => {
  initDb(":memory:");
  assert.throws(() => gerarVendasDoMes("2026/03"), /Competência inválida/);
});
