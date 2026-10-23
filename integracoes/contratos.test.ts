import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { flag, parseValorContrato } from "./contratos.js";
import {
  atualizarContrato,
  criarContrato,
  gerarVendasDoMesDetalhado,
  initDb,
  listVendas,
} from "../src/store.js";

test("CLI de Contrato aceita valor monetário pt-BR", () => {
  assert.equal(parseValorContrato("49,90"), 49.9);
});

test("CLI de Contrato recusa valor parcial", () => {
  assert.throws(() => parseValorContrato("100abc"), /--valor inválido/);
});

test("CLI de Contrato recusa opção como valor de flag", () => {
  assert.throws(
    () => flag(["--cnbs", "--cmun", "3509502"], "--cnbs"),
    /valor ausente ou inválido.*--cnbs/i,
  );
  assert.equal(flag(["--complemento", "-"], "--complemento"), "-");
});

function executarCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "integracoes/contratos.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("CLI de Contrato exige endereço do Tomador e cNBS", () => {
  const base = [
    "criar", "--doc", "11444777000161", "--nome", "Cliente", "--valor", "100",
    "--desc", "Servico", "--ctrib", "080201", "--cnbs", "122051900", "--cmun", "3509502",
    "--cep", "13000000", "--rua", "Rua", "--numero", "1", "--bairro", "Centro",
  ];
  for (const nome of ["--cnbs", "--cmun", "--cep", "--rua", "--numero", "--bairro"]) {
    const args = [...base];
    const posicao = args.indexOf(nome);
    args.splice(posicao, 2);
    const resultado = executarCli(...args);
    assert.notEqual(resultado.status, 0, `CLI aceitou ${nome} ausente`);
    assert.match(`${resultado.stdout}${resultado.stderr}`, new RegExp(nome));
  }
});

test("Contrato legado atualizado deixa de ser pulado e gera Venda", () => {
  const db = initDb(":memory:");
  const id = criarContrato({
    cliente_doc: "11444777000161",
    cliente_nome: "Contrato legado",
    cliente_cmun: "3509502",
    cliente_cep: "13000000",
    cliente_rua: "Rua",
    cliente_numero: "1",
    cliente_bairro: "Centro",
    valor: 100,
    xdesc_serv: "Servico",
    ctrib_nac: "080201",
    cnbs: "122051900",
    dia_do_mes: 1,
  });
  db.prepare("UPDATE contratos SET cliente_cep = NULL, cnbs = NULL WHERE id = ?").run(id);

  assert.deepEqual(gerarVendasDoMesDetalhado("2026-10"), {
    novas: 0,
    pulados: [{ id, cliente_nome: "Contrato legado", campos_faltantes: ["cliente_cep", "cNBS"] }],
  });

  atualizarContrato(id, {
    cliente_cmun: "3509502",
    cliente_cep: "13000000",
    cliente_rua: "Rua",
    cliente_numero: "1",
    cliente_bairro: "Centro",
    cnbs: "122051900",
  });
  assert.deepEqual(gerarVendasDoMesDetalhado("2026-10"), { novas: 1, pulados: [] });
  assert.equal(listVendas({ id_venda: `contrato-${id}-2026-10` })[0]?.contrato_id, id);
});
