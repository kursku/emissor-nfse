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

function notaComDCompet(dCompet: unknown): Parameters<typeof executarEmissaoAvulsa>[0] {
  return { ...nota, dCompet } as Parameters<typeof executarEmissaoAvulsa>[0];
}

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
    await executarEmissaoAvulsa({ ...nota, dCompet: "2026-10-01" }, {
      ambiente: 2,
      outputDir,
      agora: () => new Date("2026-10-22T12:00:00Z"),
      log: (mensagem: string) => logs.push(mensagem),
      initDb: proibido("initDb"),
      proximoNDPS: proibido("proximoNDPS"),
      buscarNotaPorVenda: proibido("buscarNotaPorVenda"),
      criarEReservarEmissao: proibido("criarEReservarEmissao"),
      concluirEmissao: proibido("concluirEmissao"),
      emitirNfse: async (input: { nDPS: string; dCompet?: string }, _antesDoEnvio, options) => {
        chamadas.push(input.nDPS);
        assert.equal(input.dCompet, "2026-10-01");
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

  await executarEmissaoAvulsa({ ...nota, dCompet: "2026-11-30" }, {
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
    emitirNfse: async (input: { nDPS: string; dCompet?: string }) => {
      chamadas.push(input.nDPS);
      assert.equal(input.dCompet, "2026-11-30");
      return { chNFSe: "9".repeat(50) };
    },
  });

  assert.equal(inicializado, 1);
  assert.equal(reservado, 1);
  assert.deepEqual(chamadas, ["41"]);
  assert.equal(concluido.length, 1);
  assert.deepEqual(logs, ["MODO REAL: a nota sera emitida de verdade na SEFIN."]);
});

test("avulsa recusa competencia malformada, inexistente ou futura antes do emissor", async () => {
  const chamadas: string[] = [];
  const casos = [
    ["10/2026", /dCompet.*AAAA-MM-DD/],
    ["2026-02-30", /dCompet.*AAAA-MM-DD/],
    ["2026-12-02", /competência futura/],
  ] as const;

  for (const [dCompet, erro] of casos) {
    await assert.rejects(
      executarEmissaoAvulsa({ ...nota, dCompet }, {
        ambiente: 1,
        outputDir,
        agora: () => new Date("2026-12-01T03:00:00Z"),
        initDb: () => undefined,
        proximoNDPS: () => 43,
        emitirNfse: async () => {
          chamadas.push(dCompet);
          return { chNFSe: "7".repeat(50) };
        },
      }),
      erro,
    );
  }

  assert.deepEqual(chamadas, []);
});

test("dCompet só aceita anos 20xx", async () => {
  for (const dCompet of ["0001-01-01", "1900-01-01"]) {
    await assert.rejects(
      executarEmissaoAvulsa(notaComDCompet(dCompet), {
        ambiente: 1,
        outputDir,
        agora: () => new Date("2026-12-01T03:00:00Z"),
        initDb: () => undefined,
        proximoNDPS: () => 60,
        emitirNfse: async () => { throw new Error("emissor nao deveria ser chamado"); },
      }),
      /dCompet.*AAAA-MM-DD/,
    );
  }
});

test("dCompet invalido nao consulta nem reserva nDPS na emissao real", async () => {
  let consultas = 0;
  let reservas = 0;
  await assert.rejects(
    executarEmissaoAvulsa(notaComDCompet("1900-01-01"), {
      ambiente: 1,
      outputDir,
      agora: () => new Date("2026-12-01T03:00:00Z"),
      initDb: () => undefined,
      proximoNDPS: () => { consultas++; return 61; },
      buscarNotaPorVenda: () => null,
      criarEReservarEmissao: () => { reservas++; return null; },
    }),
    /dCompet/,
  );
  assert.equal(consultas, 0);
  assert.equal(reservas, 0);
});

test("dCompet acompanha a data de Sao Paulo, hoje e ano bissexto", async () => {
  const aceitos = [
    ["2026-12-01", "2026-12-01T03:00:00Z"],
    ["2028-02-29", "2028-03-01T03:00:00Z"],
  ] as const;
  for (const [dCompet, instante] of aceitos) {
    let recebida: string | undefined;
    await executarEmissaoAvulsa(notaComDCompet(dCompet), {
      ambiente: 1,
      outputDir,
      agora: () => new Date(instante),
      initDb: () => undefined,
      proximoNDPS: () => 62,
      buscarNotaPorVenda: () => null,
      criarEReservarEmissao: () => ({
        id: 1,
        id_venda: nota.idVenda,
        ndps: 62,
        estado: "reservada",
        chave_acesso: null,
        criada_em: instante,
        atualizada_em: instante,
      }),
      concluirEmissao: () => undefined,
      emitirNfse: async (input) => {
        recebida = input.dCompet;
        return { chNFSe: "7".repeat(50) };
      },
    });
    assert.equal(recebida, dCompet);
  }
});

test("dCompet do dia seguinte ainda e futuro antes da meia-noite em Sao Paulo", async () => {
  await assert.rejects(
    executarEmissaoAvulsa(notaComDCompet("2026-12-01"), {
      ambiente: 1,
      outputDir,
      agora: () => new Date("2026-12-01T01:00:00Z"),
      initDb: () => undefined,
      proximoNDPS: () => 63,
    }),
    /competência futura/,
  );
});

test("dCompet nao-string e rejeitado na avulsa e no ensaio antes do emissor", async () => {
  for (const dCompet of [null, 20261001]) {
    let emissoes = 0;
    await assert.rejects(
      executarEmissaoAvulsa(notaComDCompet(dCompet), {
        ambiente: 2,
        outputDir,
        agora: () => new Date("2026-12-01T03:00:00Z"),
        emitirNfse: async () => { emissoes++; return { chNFSe: "6".repeat(50) }; },
      }),
      /dCompet/,
    );
    assert.equal(emissoes, 0);
  }
});

test("conferencia inclui dCompet informado", async () => {
  const anterior = process.env["EMITIR_REAL"];
  const logs: string[] = [];
  const originalLog = console.log;
  process.env["EMITIR_REAL"] = "0";
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await executarEmissaoAvulsa(notaComDCompet("2026-11-30"), {
      ambiente: 1,
      outputDir,
      agora: () => new Date("2026-12-01T03:00:00Z"),
      initDb: () => undefined,
      proximoNDPS: () => 64,
    });
  } finally {
    console.log = originalLog;
    if (anterior === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = anterior;
  }
  assert.match(logs.join("\n"), /dCompet.*2026-11-30/);
});

test.after(() => rmSync(outputDir, { recursive: true, force: true }));
