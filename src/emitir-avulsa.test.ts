import { mkdirSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb, proximoNDPS } from "./store.js";

const outputDir = mkdtempSync(join(tmpdir(), "nfse-avulsa-"));
writeFileSync(join(outputDir, "ndps.json"), JSON.stringify({ proximoNDPS: 42 }));
process.env["NFSE_CNPJ"] = "11222333000181";
process.env["NFSE_COD_MUNICIPIO"] = "3509502";
process.env["NFSE_CERT_PATH"] = join(outputDir, "certificado-inexistente.p12");
process.env["NFSE_CERT_PASSWORD"] = "teste";
process.env["NFSE_IM"] = "1";
process.env["NFSE_UF"] = "SP";
process.env["NFSE_OUTPUT_DIR"] = outputDir;
process.env["EMITIR_REAL"] = "1";

const { executarEmissaoAvulsa } = await import("./emitir-avulsa.js");

const nota = {
  idVenda: "venda-teste-avulsa",
  tomador: {
    CNPJ: "11222333000181",
    xNome: "TOMADOR DE TESTE",
    end: { cMun: "3509502", CEP: "13000000", xLgr: "Rua Teste", nro: "1", xBairro: "Centro" },
  },
  xDescServ: "Servico de teste",
  vServ: 100,
  cTribNac: "080201",
  cNBS: "122051900",
};

test("avulsa em modo real na produção restrita faz ensaio sem persistir", async () => {
  const chamadas: string[] = [];
  const logs: string[] = [];
  let pastaEnsaio: string | undefined;
  const proibido = (nome: string) => () => { throw new Error(`${nome} não deveria ser chamado`); };

  try {
    await executarEmissaoAvulsa(nota, {
      ambiente: 2,
      outputDir,
      agora: () => new Date("2026-10-22T12:00:00Z"),
      log: (mensagem: string) => logs.push(mensagem),
      initDb: proibido("initDb"),
      proximoNDPS: proibido("proximoNDPS"),
      buscarNotaPorVenda: proibido("buscarNotaPorVenda"),
      criarEReservarEmissao: proibido("criarEReservarEmissao"),
      concluirEmissao: proibido("concluirEmissao"),
      emitirNfse: async (input: { nDPS: string }, _antesDoEnvio, options) => {
        chamadas.push(input.nDPS);
        pastaEnsaio = options?.outputDir;
        assert.ok(pastaEnsaio);
        assert.notEqual(pastaEnsaio, outputDir);
        mkdirSync(join(pastaEnsaio, "autorizacao"));
        mkdirSync(join(pastaEnsaio, "retorno"));
        writeFileSync(
          join(pastaEnsaio, `resultado-ndps-${input.nDPS}.json`),
          JSON.stringify({ chNFSe: "8".repeat(50) }),
        );
        return { chNFSe: "8".repeat(50), cStat: "100", codigo: "E0001" };
      },
    });

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0], "1792670400000");
    assert.match(chamadas[0], /^\d{13}$/);
    assert.match(logs.join("\n"), /ENSAIO \(produção restrita\): grava só em /);
    assert.match(logs.join("\n"), /AUTORIZADA\. chave=8{50}/);
    assert.ok(pastaEnsaio);
    const relativo = relative(tmpdir(), pastaEnsaio);
    assert.ok(!isAbsolute(relativo) && !relativo.startsWith(".."));
    assert.deepEqual(readdirSync(outputDir), ["ndps.json"]);
    initDb(":memory:");
    assert.equal(proximoNDPS(outputDir), 42);
    assert.deepEqual(readdirSync(pastaEnsaio).sort(), [
      "autorizacao",
      "resultado-ndps-1792670400000.json",
      "retorno",
    ]);
  } finally {
    if (pastaEnsaio) rmSync(pastaEnsaio, { recursive: true, force: true });
  }
});

test("avulsa em produção real preserva a persistência após o corte", async () => {
  const chamadas: string[] = [];
  const concluido: unknown[] = [];
  const logs: string[] = [];
  let inicializado = 0;
  let reservado = 0;

  await executarEmissaoAvulsa(nota, {
    ambiente: 1,
    outputDir,
    agora: () => new Date("2026-12-01T03:00:00Z"),
    log: (mensagem: string) => logs.push(mensagem),
    initDb: () => { inicializado++; },
    proximoNDPS: () => 41,
    buscarNotaPorVenda: () => null,
    criarEReservarEmissao: () => {
      reservado++;
      return {
        id: 1,
        id_venda: nota.idVenda,
        ndps: 41,
        estado: "reservada",
        chave_acesso: null,
        criada_em: "2026-12-01T03:00:00.000Z",
        atualizada_em: "2026-12-01T03:00:00.000Z",
      };
    },
    concluirEmissao: (registro: unknown) => { concluido.push(registro); },
    emitirNfse: async (input: { nDPS: string }) => {
      chamadas.push(input.nDPS);
      return { chNFSe: "9".repeat(50) };
    },
  });

  assert.equal(inicializado, 1);
  assert.equal(reservado, 1);
  assert.deepEqual(chamadas, ["41"]);
  assert.equal(concluido.length, 1);
  assert.deepEqual(logs, ["MODO REAL: a nota sera emitida de verdade na SEFIN."]);
});

test.after(() => rmSync(outputDir, { recursive: true, force: true }));
