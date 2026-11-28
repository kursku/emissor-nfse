/**
 * Rotas de leitura das Notas (Fechamento), exercitadas por HTTP sobre um banco
 * temporário e XMLs sintéticos. Todos os dados são falsos.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import assert from "node:assert/strict";

import { initDb, registrarNota, upsertVenda } from "../store.js";
import { createPainelApp, lerPastaDasNotas } from "./server.js";

const MODELO = readFileSync(new URL("../fixtures/danfse-sintetica.xml", import.meta.url), "utf8");

const CHAVE_A = "1".repeat(50);
const CHAVE_B = "2".repeat(50);
const CHAVE_C = "3".repeat(50);
const CHAVE_D = "4".repeat(50);
const CHAVE_E = "5".repeat(50);

interface Xml {
  chave: string;
  nNFSe: string;
  dCompet: string;
  /** Já escapado como vai no XML */
  xNome: string;
  doc: string;
  vServ: string;
  /** 1=produção (padrão aqui), 2=homologação */
  tpAmb?: "1" | "2";
}

function xmlAutorizado({ chave, nNFSe, dCompet, xNome, doc, vServ, tpAmb = "1" }: Xml): string {
  return MODELO
    // O modelo é de homologação.
    .replace("<tpAmb>2</tpAmb>", `<tpAmb>${tpAmb}</tpAmb>`)
    .replace(`Id="NFS${"9".repeat(50)}"`, `Id="NFS${chave}"`)
    .replace("<nNFSe>42</nNFSe>", `<nNFSe>${nNFSe}</nNFSe>`)
    .replace("<dCompet>2026-10-26</dCompet>", `<dCompet>${dCompet}</dCompet>`)
    .replace(/<toma>[\s\S]*<\/toma>/, `<toma>${doc}<xNome>${xNome}</xNome></toma>`)
    .replace("<vServ>123.45</vServ>", `<vServ>${vServ}</vServ>`);
}

async function gravarXml(outputDir: string, dados: Xml): Promise<void> {
  await writeFile(join(outputDir, "autorizacao", `${dados.chave}.xml`), xmlAutorizado(dados));
}

function nota(id: string, chave: string, ndps: number, emitidaEm: string, valor: number, nome: string, doc: string): void {
  upsertVenda({ id_venda: id, valor, nome, cpf_cnpj: doc, data_venda: "2026-07-01", status: "emitida" });
  registrarNota({ chave_acesso: chave, ndps, id_venda: id, emitida_em: emitidaEm });
}

/** A, B, E têm XML; C e D não. A Venda de quem tem XML diverge dele de propósito. */
async function semear(dbPath: string, outputDir: string): Promise<void> {
  initDb(dbPath);
  nota("venda-a", CHAVE_A, 11, "2026-10-20T15:00:00.000Z", 999.99, "Nome da Venda A", "52998224725");
  nota("venda-b", CHAVE_B, 12, "2026-09-15T15:00:00.000Z", 888.88, "Nome da Venda B", "52998224725");
  // 01/11 01:30 UTC ainda é 31/10 em São Paulo.
  nota("venda-c", CHAVE_C, 13, "2026-11-01T01:30:00.000Z", 300.05, "Cliente Sem XML", "52998224725");
  nota("venda-d", CHAVE_D, 14, "2026-09-02T15:00:00.000Z", 50, "Outro Sem XML", "11222333000181");
  nota("venda-e", CHAVE_E, 15, "2026-08-10T15:00:00.000Z", 777.77, "Nome da Venda E", "52998224725");
  await mkdir(join(outputDir, "autorizacao"), { recursive: true });
  await gravarXml(outputDir, {
    chave: CHAVE_A,
    nNFSe: "101",
    dCompet: "2026-09-30",
    xNome: "Silva &amp; Filhos &#201;tica &#x3c;ME&#62;",
    doc: "<CNPJ>11444777000161</CNPJ>",
    vServ: "1000.10",
  });
  await gravarXml(outputDir, {
    chave: CHAVE_B,
    nNFSe: "102",
    dCompet: "2026-09-15",
    xNome: "Literal &amp;#201; Dois",
    doc: "<CPF>11144477735</CPF>",
    vServ: "2000.20",
  });
  await gravarXml(outputDir, {
    chave: CHAVE_E,
    nNFSe: "100",
    dCompet: "2026-08-10",
    xNome: "Tomador Agosto",
    doc: "<CPF>11144477735</CPF>",
    vServ: "10.00",
  });
}

interface Ambiente {
  base: string;
  root: string;
  dbPath: string;
  outputDir: string;
}

async function comNotas(
  usar: (ambiente: Ambiente) => Promise<void>,
  preparar: (dbPath: string, outputDir: string) => Promise<void> = semear,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nfse-notas-"));
  const dbPath = join(root, "emissor.db");
  const outputDir = join(root, "saida");
  await mkdir(outputDir);
  await preparar(dbPath, outputDir);
  const server = createServer(createPainelApp({ panelPort: 0, dbPath, outputDir }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await usar({ base: `http://127.0.0.1:${port}`, root, dbPath, outputDir });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    initDb(":memory:");
    await rm(root, { recursive: true, force: true });
  }
}

async function json(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

test("competências vêm da mais recente para a mais antiga, com total, quantidade e estimada", async () => {
  await comNotas(async ({ base }) => {
    const { status, body } = await json(`${base}/api/notas/competencias`);

    assert.equal(status, 200);
    assert.deepEqual(body, [
      { competencia: "2026-10", total: 300.05, quantidade: 1, estimada: true },
      { competencia: "2026-09", total: 3050.3, quantidade: 3, estimada: true },
      { competencia: "2026-08", total: 10, quantidade: 1, estimada: false },
    ]);
  });
});

test("Notas da competência: XML vence a Venda, entidades decodificadas e documento mascarado", async () => {
  await comNotas(async ({ base, outputDir }) => {
    await writeFile(join(outputDir, `danfse-${CHAVE_B}.pdf`), "%PDF-sintetico %%EOF");

    const { status, body } = await json(`${base}/api/notas?competencia=2026-09`);

    assert.equal(status, 200);
    assert.deepEqual(body, {
      competencia: "2026-09",
      total: 3050.3,
      quantidade: 3,
      notas: [
        {
          nNFSe: null,
          ndps: 14,
          chave: CHAVE_D,
          emitidaEm: "2026-09-02T15:00:00.000Z",
          competencia: "2026-09",
          competenciaEstimada: true,
          homologacao: false,
          tomador: "Outro Sem XML",
          documentoMascarado: "112...81",
          valor: 50,
          idVenda: "venda-d",
          temXml: false,
          temPdf: false,
        },
        {
          nNFSe: "102",
          ndps: 12,
          chave: CHAVE_B,
          emitidaEm: "2026-09-15T15:00:00.000Z",
          competencia: "2026-09",
          competenciaEstimada: false,
          homologacao: false,
          tomador: "Literal &#201; Dois",
          documentoMascarado: "111...35",
          valor: 2000.2,
          idVenda: "venda-b",
          temXml: true,
          temPdf: true,
        },
        {
          nNFSe: "101",
          ndps: 11,
          chave: CHAVE_A,
          emitidaEm: "2026-10-20T15:00:00.000Z",
          competencia: "2026-09",
          competenciaEstimada: false,
          homologacao: false,
          tomador: "Silva & Filhos Ética <ME>",
          documentoMascarado: "114...61",
          valor: 1000.1,
          idVenda: "venda-a",
          temXml: true,
          temPdf: false,
        },
      ],
    });
  });
});

test("sem XML a competência é o mês de emissão em São Paulo, marcada como estimada", async () => {
  await comNotas(async ({ base }) => {
    const { body } = await json(`${base}/api/notas?competencia=2026-10`);

    assert.equal(body.total, 300.05);
    assert.equal(body.notas.length, 1);
    assert.equal(body.notas[0].chave, CHAVE_C);
    assert.equal(body.notas[0].competenciaEstimada, true);
    assert.equal(body.notas[0].tomador, "Cliente Sem XML");
    assert.equal(body.notas[0].documentoMascarado, "529...25");
    assert.equal(body.notas[0].valor, 300.05);
  });
});

test("XML ilegível ou de outra chave não é usado: vale a Venda, marcada como estimada", async () => {
  await comNotas(async ({ base, outputDir }) => {
    const pasta = join(outputDir, "autorizacao");
    await writeFile(join(pasta, `${CHAVE_C}.xml`), "<NFSe>quebrado");
    await writeFile(join(pasta, `${CHAVE_D}.xml`), readFileSync(join(pasta, `${CHAVE_B}.xml`)));
    const originalWarn = console.warn;
    const avisos: string[] = [];
    console.warn = (mensagem: string) => { avisos.push(mensagem); };
    try {
      const outubro = (await json(`${base}/api/notas?competencia=2026-10`)).body;
      assert.equal(outubro.notas[0].valor, 300.05);
      assert.equal(outubro.notas[0].competenciaEstimada, true);
      assert.equal(outubro.notas[0].temXml, true);
      const setembro = (await json(`${base}/api/notas?competencia=2026-09`)).body;
      assert.equal(setembro.notas[0].chave, CHAVE_D);
      assert.equal(setembro.notas[0].valor, 50);
      assert.equal(setembro.notas[0].competenciaEstimada, true);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(avisos.some((aviso) => aviso.includes(CHAVE_C)), "XML quebrado precisa ser avisado");
    assert.ok(avisos.some((aviso) => aviso.includes(CHAVE_D)), "chave divergente precisa ser avisada");
  });
});

test("XML trocado no disco vale na consulta seguinte, e XML removido volta para a Venda", async () => {
  await comNotas(async ({ base, outputDir }) => {
    const url = `${base}/api/notas?competencia=2026-08`;
    assert.equal((await json(url)).body.total, 10);

    await gravarXml(outputDir, {
      chave: CHAVE_E,
      nNFSe: "100",
      dCompet: "2026-08-10",
      xNome: "Tomador Agosto",
      doc: "<CPF>11144477735</CPF>",
      vServ: "1234.56",
    });
    assert.equal((await json(url)).body.total, 1234.56);

    // Mesmo tamanho, outra data de modificação.
    await gravarXml(outputDir, {
      chave: CHAVE_E,
      nNFSe: "100",
      dCompet: "2026-08-10",
      xNome: "Tomador Agosto",
      doc: "<CPF>11144477735</CPF>",
      vServ: "4321.65",
    });
    const depoisDaTroca = new Date("2030-01-01T00:00:00Z");
    await utimes(join(outputDir, "autorizacao", `${CHAVE_E}.xml`), depoisDaTroca, depoisDaTroca);
    assert.equal((await json(url)).body.total, 4321.65);

    await rm(join(outputDir, "autorizacao", `${CHAVE_E}.xml`));
    const depois = (await json(url)).body;
    assert.equal(depois.total, 777.77);
    assert.equal(depois.notas[0].temXml, false);
    assert.equal(depois.notas[0].competenciaEstimada, true);
  });
});

test("XML sem tomador continua valendo: valor e mês do XML, tomador vazio", async () => {
  await comNotas(async ({ base, outputDir }) => {
    const semTomador = xmlAutorizado({
      chave: CHAVE_E,
      nNFSe: "100",
      dCompet: "2026-08-10",
      xNome: "",
      doc: "",
      vServ: "25.00",
    }).replace(/<toma>[\s\S]*<\/toma>/, "");
    await writeFile(join(outputDir, "autorizacao", `${CHAVE_E}.xml`), semTomador);

    const { body } = await json(`${base}/api/notas?competencia=2026-08`);

    assert.equal(body.total, 25);
    assert.equal(body.notas[0].competenciaEstimada, false);
    assert.equal(body.notas[0].tomador, null);
    assert.equal(body.notas[0].documentoMascarado, "");
  });
});

test("Nota sem Venda, valor ilegível e datas incompletas continuam listadas", async () => {
  await comNotas(
    async ({ base }) => {
      const { body } = await json(`${base}/api/notas?competencia=2026-07`);

      assert.equal(body.quantidade, 3);
      assert.equal(body.total, 40);
      assert.deepEqual(
        body.notas.map((n: any) => [n.chave, n.idVenda, n.valor]),
        [
          // Sem data de emissão: vale a data da Venda.
          [CHAVE_C, "venda-texto", null],
          // Data sem hora não pode escorregar para o dia (e mês) anterior.
          [CHAVE_A, null, null],
          [CHAVE_B, "venda-ok", 40],
        ],
      );
    },
    async (dbPath) => {
      initDb(dbPath);
      registrarNota({ chave_acesso: CHAVE_A, ndps: 1, emitida_em: "2026-07-01" });
      upsertVenda({ id_venda: "venda-ok", valor: 40, status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_B, ndps: 2, id_venda: "venda-ok", emitida_em: "2026-07-02T15:00:00.000Z" });
      upsertVenda({ id_venda: "venda-texto", valor: "1.234,56" as unknown as number, data_venda: "2026-07-09", status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_C, ndps: 3, id_venda: "venda-texto", emitida_em: "" });
    },
  );
});

test("a ordem das competências segue o mês do XML, não a ordem de emissão", async () => {
  await comNotas(async ({ base, outputDir }) => {
    // C é a última emitida; o XML dela declara a competência mais antiga.
    await gravarXml(outputDir, {
      chave: CHAVE_C,
      nNFSe: "103",
      dCompet: "2026-01-31",
      xNome: "Tomador Retroativo",
      doc: "<CPF>11144477735</CPF>",
      vServ: "5.00",
    });

    const { body } = await json(`${base}/api/notas/competencias`);

    assert.deepEqual(body.map((c: any) => c.competencia), ["2026-09", "2026-08", "2026-01"]);
  });
});

test("banco ilegível responde erro, nunca lista vazia", async () => {
  await comNotas(async ({ base, dbPath }) => {
    initDb(":memory:");
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await writeFile(dbPath, "isto não é um banco SQLite ".repeat(100));
    const originalError = console.error;
    console.error = () => {};
    try {
      for (const rota of ["/api/notas/competencias", "/api/notas?competencia=2026-09"]) {
        const { status, body } = await json(`${base}${rota}`);
        assert.equal(status, 500, rota);
        assert.deepEqual(body, { erro: "Falha ao ler as Notas" }, rota);
      }
    } finally {
      console.error = originalError;
    }
  });
});

test("NFSE_OUTPUT_DIR em branco cai na pasta padrão, como no config", () => {
  const padrao = fileURLToPath(new URL("../../output/nfewizard", import.meta.url));
  assert.equal(lerPastaDasNotas({ NFSE_OUTPUT_DIR: "  " }, "nao-existe"), padrao);
  assert.equal(lerPastaDasNotas({}, "nao-existe"), padrao);
});

test("Nota de homologação aparece marcada e fica fora do total nas duas rotas", async () => {
  await comNotas(
    async ({ base }) => {
      assert.deepEqual((await json(`${base}/api/notas/competencias`)).body, [
        { competencia: "2026-07", total: 0, quantidade: 0, estimada: false },
        { competencia: "2026-06", total: 100.5, quantidade: 1, estimada: false },
      ]);

      const junho = (await json(`${base}/api/notas?competencia=2026-06`)).body;
      assert.equal(junho.total, 100.5);
      assert.equal(junho.quantidade, 1);
      assert.deepEqual(
        junho.notas.map((n: any) => [n.chave, n.valor, n.homologacao]),
        [
          [CHAVE_A, 100.5, false],
          [CHAVE_B, 7000, true],
        ],
      );

      const julho = (await json(`${base}/api/notas?competencia=2026-07`)).body;
      assert.equal(julho.total, 0);
      assert.equal(julho.quantidade, 0);
      assert.equal(julho.notas.length, 1);
      assert.equal(julho.notas[0].homologacao, true);
    },
    async (dbPath, outputDir) => {
      initDb(dbPath);
      await mkdir(join(outputDir, "autorizacao"), { recursive: true });
      const comuns = { xNome: "Tomador Sintético", doc: "<CPF>11144477735</CPF>" };
      nota("venda-prod", CHAVE_A, 1, "2026-06-01T15:00:00.000Z", 1, "Venda", "52998224725");
      await gravarXml(outputDir, { ...comuns, chave: CHAVE_A, nNFSe: "1", dCompet: "2026-06-01", vServ: "100.50" });
      nota("venda-homolog", CHAVE_B, 2, "2026-06-02T15:00:00.000Z", 1, "Venda", "52998224725");
      await gravarXml(outputDir, { ...comuns, chave: CHAVE_B, nNFSe: "2", dCompet: "2026-06-02", vServ: "7000.00", tpAmb: "2" });
      nota("venda-so-homolog", CHAVE_C, 3, "2026-07-03T15:00:00.000Z", 1, "Venda", "52998224725");
      await gravarXml(outputDir, { ...comuns, chave: CHAVE_C, nNFSe: "3", dCompet: "2026-07-03", vServ: "9.00", tpAmb: "2" });
    },
  );
});

test("tomador de 120 caracteres volta inteiro e decodificado", async () => {
  await comNotas(async ({ base, outputDir }) => {
    await gravarXml(outputDir, {
      chave: CHAVE_E,
      nNFSe: "100",
      dCompet: "2026-08-10",
      xNome: "Fict&#237;cia &amp; " + "Z".repeat(109),
      doc: "<CPF>11144477735</CPF>",
      vServ: "10.00",
    });

    const { body } = await json(`${base}/api/notas?competencia=2026-08`);

    assert.equal(body.notas[0].tomador, "Fictícia & " + "Z".repeat(109));
    assert.equal(body.notas[0].tomador.length, 120);
  });
});

test("XML ruim que não mudou é lido e avisado uma vez só", async () => {
  await comNotas(async ({ base, outputDir }) => {
    const caminho = join(outputDir, "autorizacao", `${CHAVE_E}.xml`);
    const bom = readFileSync(caminho, "utf8");
    const ruim = bom.replace("<dCompet>2026-08-10</dCompet>", "<dCompet>XXXX-XX-XX</dCompet>");
    const data = new Date("2030-01-01T00:00:00Z");
    const gravar = async (xml: string) => {
      await writeFile(caminho, xml);
      await utimes(caminho, data, data);
    };
    const originalWarn = console.warn;
    const avisos: string[] = [];
    console.warn = (mensagem: string) => { avisos.push(mensagem); };
    try {
      const url = `${base}/api/notas?competencia=2026-08`;
      await gravar(ruim);
      // Consultas simultâneas também fazem um parse só.
      for (const { body } of await Promise.all([json(url), json(url)])) assert.equal(body.total, 777.77);
      // Mesmo tamanho e mesma data: se o XML fosse lido de novo, o total voltaria a ser o dele.
      await gravar(bom);
      assert.equal((await json(url)).body.total, 777.77);
      assert.equal(avisos.filter((aviso) => aviso.includes(CHAVE_E)).length, 1);

      // Data nova: a recusa guardada não vale mais.
      const depois = new Date("2031-01-01T00:00:00Z");
      await utimes(caminho, depois, depois);
      assert.equal((await json(url)).body.total, 10);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("nome que só o parser estrito recusa não descarta o resto do XML", async () => {
  await comNotas(async ({ base, outputDir }) => {
    await gravarXml(outputDir, {
      chave: CHAVE_E,
      nNFSe: "100",
      dCompet: "2026-08-10",
      xNome: "Alfa & Beta",
      doc: "<CPF>11144477735</CPF>",
      vServ: "25.00",
    });
    const originalWarn = console.warn;
    const avisos: string[] = [];
    console.warn = (mensagem: string) => { avisos.push(mensagem); };
    try {
      const { body } = await json(`${base}/api/notas?competencia=2026-08`);

      assert.equal(body.total, 25);
      assert.equal(body.notas[0].competenciaEstimada, false);
      assert.equal(body.notas[0].tomador, "Alfa & Beta");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(avisos.filter((aviso) => aviso.includes(CHAVE_E)).length, 1);
  });
});

test("o Fechamento marca a homologação, mostra o mês só dela e rotula cada opção com o próprio resumo", () => {
  const html = readFileSync(new URL("./painel.html", import.meta.url), "utf8");
  assert.match(html, /if \(nota\.homologacao\) \{[\s\S]*?'homologação, fora do total'[\s\S]*?valor\.append\([^;]*selo\)/);
  assert.match(html, /if \(mes\.notas\.length === 0\)/);
  assert.match(html, /rotuloDaCompetencia\(c, lista\.find\(r => r\.competencia === c\)\)/);
});

test("a opção do seletor mostra mês, total e quantidade da competência", () => {
  const html = readFileSync(new URL("./painel.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fonte = /function rotuloDaCompetencia[\s\S]*?\n}\n/.exec(html)?.[0];
  assert.ok(fonte, "rotuloDaCompetencia não encontrada");
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const rotulo = new Function("brl", `${fonte}return rotuloDaCompetencia;`)(brl);

  assert.equal(
    rotulo("2026-11", { total: 1234, quantidade: 5, estimada: false }),
    "nov/2026 · R$\u00a01.234,00 · 5 notas",
  );
  assert.equal(
    rotulo("2026-05", { total: 0.5, quantidade: 1, estimada: true }),
    "mai/2026 · R$\u00a00,50 · 1 nota (estimada)",
  );
  assert.equal(rotulo("2020-01", undefined), "jan/2020");
});

async function comAvisos(usar: () => Promise<void>): Promise<string[]> {
  const originalWarn = console.warn;
  const avisos: string[] = [];
  console.warn = (mensagem: string) => { avisos.push(mensagem); };
  try {
    await usar();
  } finally {
    console.warn = originalWarn;
  }
  return avisos;
}

test("data que não é ISO real nunca vira competência nem é adivinhada", async () => {
  await comNotas(
    async ({ base }) => {
      const avisos = await comAvisos(async () => {
        assert.deepEqual((await json(`${base}/api/notas/competencias`)).body, [
          { competencia: "2026-07", total: 60, quantidade: 3, estimada: true },
        ]);
      });

      // Sem nenhuma data legível: fora da tela, com aviso.
      assert.ok(avisos.some((aviso) => aviso.includes("fora do Fechamento, nDPS 1")), "mês 25 e 13");
      assert.ok(avisos.some((aviso) => aviso.includes("fora do Fechamento, nDPS 3")), "data com espaços");
      // Caiu para a data da Venda, mas a data recusada é avisada.
      assert.ok(avisos.some((aviso) => aviso.includes("emitida_em ilegível") && aviso.includes("nDPS 2")), "DD/MM/AAAA");
      assert.ok(avisos.some((aviso) => aviso.includes("data_venda ilegível") && aviso.includes("nDPS 3")), "30/02");
      assert.ok(avisos.some((aviso) => aviso.includes("fora do Fechamento, nDPS 6")), "hora sem fuso");
      assert.ok(avisos.some((aviso) => aviso.includes("fora do Fechamento, nDPS 7")), "hora 25");

      // Data recusada não chega à tela, para não ser exibida como se valesse.
      const { body } = await json(`${base}/api/notas?competencia=2026-07`);
      assert.deepEqual(
        body.notas.map((n: any) => [n.ndps, n.emitidaEm]),
        [
          [5, "2026-07-04T15:00:00Z"],
          [4, "2026-07-31T23:00:00-03:00"],
          [2, null],
        ],
      );
      assert.ok(avisos.some((aviso) => aviso.includes("dCompet") && aviso.includes(CHAVE_E)), "mês 13 no XML");
    },
    async (dbPath, outputDir) => {
      initDb(dbPath);
      upsertVenda({ id_venda: "venda-mes", valor: 1, data_venda: "2026-25-09", status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_A, ndps: 1, id_venda: "venda-mes", emitida_em: "2026-13-01" });
      upsertVenda({ id_venda: "venda-br", valor: 10, data_venda: "2026-07-02", status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_B, ndps: 2, id_venda: "venda-br", emitida_em: "30/09/2026" });
      upsertVenda({ id_venda: "venda-espacos", valor: 1, data_venda: "2026-02-30", status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_C, ndps: 3, id_venda: "venda-espacos", emitida_em: " 2026-07-01 " });
      upsertVenda({ id_venda: "venda-offset", valor: 20, status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_D, ndps: 4, id_venda: "venda-offset", emitida_em: "2026-07-31T23:00:00-03:00" });
      registrarNota({ chave_acesso: "6".repeat(50), ndps: 6, emitida_em: "2026-07-01T10:00:00" });
      registrarNota({ chave_acesso: "7".repeat(50), ndps: 7, emitida_em: "2026-07-01T25:00:00Z" });
      upsertVenda({ id_venda: "venda-xml", valor: 30, status: "emitida" });
      registrarNota({ chave_acesso: CHAVE_E, ndps: 5, id_venda: "venda-xml", emitida_em: "2026-07-04T15:00:00Z" });
      await mkdir(join(outputDir, "autorizacao"), { recursive: true });
      await gravarXml(outputDir, {
        chave: CHAVE_E,
        nNFSe: "5",
        dCompet: "2026-13-10",
        xNome: "Tomador Sintético",
        doc: "<CPF>11144477735</CPF>",
        vServ: "999.00",
      });
    },
  );
});

test("dCompet com dia que não existe no calendário cai para a Venda, como estimada", async () => {
  await comNotas(
    async ({ base }) => {
      const avisos = await comAvisos(async () => {
        assert.deepEqual((await json(`${base}/api/notas/competencias`)).body, [
          { competencia: "2026-07", total: 30, quantidade: 2, estimada: true },
        ]);
      });
      const { body } = await json(`${base}/api/notas?competencia=2026-07`);
      assert.deepEqual(
        body.notas.map((n: any) => [n.ndps, n.competenciaEstimada, n.valor, n.temXml]),
        [
          [1, true, 10, true],
          [2, true, 20, true],
        ],
      );
      for (const chave of [CHAVE_A, CHAVE_B]) {
        assert.ok(avisos.some((aviso) => aviso.includes("dCompet") && aviso.includes(chave)), chave);
      }
    },
    async (dbPath, outputDir) => {
      initDb(dbPath);
      nota("venda-iso", CHAVE_A, 1, "2026-07-05T15:00:00.000Z", 10, "Venda", "52998224725");
      nota("venda-br", CHAVE_B, 2, "2026-07-06T15:00:00.000Z", 20, "Venda", "52998224725");
      await mkdir(join(outputDir, "autorizacao"), { recursive: true });
      const comuns = { xNome: "Tomador Sintético", doc: "<CPF>11144477735</CPF>", vServ: "999.00" };
      await gravarXml(outputDir, { ...comuns, chave: CHAVE_A, nNFSe: "1", dCompet: "2026-02-30" });
      // Fora do ISO o parser do DANFSe devolve o texto como veio.
      await gravarXml(outputDir, { ...comuns, chave: CHAVE_B, nNFSe: "2", dCompet: "31/02/2026" });
    },
  );
});

/** Notas sem XML em 2026-07, uma por valor de Venda. */
function seValores(...valores: number[]) {
  return async (dbPath: string): Promise<void> => {
    initDb(dbPath);
    valores.forEach((valor, i) => {
      nota(`venda-${i}`, String(i + 1).repeat(50), i + 1, `2026-07-0${i + 1}T15:00:00.000Z`, valor, "Venda", "52998224725");
    });
  };
}

test("cada valor é arredondado uma vez e o total soma o que as linhas mostram", async () => {
  await comNotas(async ({ base }) => {
    const { body } = await json(`${base}/api/notas?competencia=2026-07`);

    assert.deepEqual(body.notas.map((n: any) => n.valor), [1.01, 2.01]);
    assert.equal(body.total, 3.02);
  }, seValores(1.005, 2.005));
});

test("valor não finito é tratado como ausente e não zera o mês", async () => {
  await comNotas(async ({ base }) => {
    const { body } = await json(`${base}/api/notas?competencia=2026-07`);

    assert.deepEqual(body.notas.map((n: any) => n.valor), [null, 10, -0.13]);
    assert.equal(body.total, 9.87);
  }, seValores(9e999, 10, -0.125));
});

test("valor que não dá para arredondar fica de fora e é avisado; resíduo de float vale zero", async () => {
  await comNotas(async ({ base }) => {
    const avisos = await comAvisos(async () => {
      const { status, body } = await json(`${base}/api/notas?competencia=2026-07`);

      assert.equal(status, 200);
      assert.deepEqual(body.notas.map((n: any) => n.valor), [null, 10, 0]);
      assert.equal(body.total, 10);
    });
    assert.deepEqual(avisos, ["[notas] valor da Venda inutilizável, nDPS 1"]);
  }, seValores(1e20, 10, 0.1 + 0.2 - 0.3));
});

test("trava curta de quem grava não derruba a leitura", async () => {
  await comNotas(async ({ base, dbPath }) => {
    initDb(":memory:");
    // Em outra thread: a espera do SQLite é síncrona e prenderia quem solta a trava.
    const escritor = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData);
      db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      parentPort.postMessage("travado");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      db.exec("COMMIT");
      db.close();`,
      { eval: true, workerData: dbPath },
    );
    const fim = once(escritor, "exit");
    await once(escritor, "message");

    const { status, body } = await json(`${base}/api/notas?competencia=2026-08`);
    await fim;

    assert.equal(status, 200);
    assert.equal(body.total, 10);
  });
});

test("pasta no lugar do XML ou do PDF não conta como arquivo", async () => {
  await comNotas(async ({ base, outputDir }) => {
    await mkdir(join(outputDir, "autorizacao", `${CHAVE_C}.xml`));
    await mkdir(join(outputDir, `danfse-${CHAVE_C}.pdf`));

    const { body } = await json(`${base}/api/notas?competencia=2026-10`);

    assert.equal(body.notas[0].temXml, false);
    assert.equal(body.notas[0].temPdf, false);
    assert.equal(body.notas[0].valor, 300.05);
  });
});

test("sair do Fechamento invalida o pedido em andamento", () => {
  const html = readFileSync(new URL("./painel.html", import.meta.url), "utf8");
  assert.match(html, /if \(atual === 'fechamento'\) carregarFechamento\(\);\s*else pedidoFechamento\+\+;/);
  assert.match(html, /buscarJson\('\/api\/notas\/competencias'\);\s*if \(pedido !== pedidoFechamento\) return;/);
});

test("o Fechamento monta as linhas sem concatenar HTML", () => {
  const html = readFileSync(new URL("./painel.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf("// --- Fechamento"), html.indexOf("window.addEventListener('popstate'"));
  assert.match(script, /function linhaDaNota/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test("competência fora do formato AAAA-MM responde 400", async () => {
  await comNotas(async ({ base }) => {
    const ruins = [
      "",
      "?competencia=",
      "?competencia=2026-9",
      "?competencia=2026-13",
      "?competencia=2026-00",
      "?competencia=2026-09-01",
      "?competencia=..%2F..",
      "?competencia=2026-09&competencia=2026-10",
    ];
    for (const query of ruins) {
      const { status, body } = await json(`${base}/api/notas${query}`);
      assert.equal(status, 400, query);
      assert.equal(body.erro, "Competência inválida: use AAAA-MM", query);
    }
    assert.deepEqual((await json(`${base}/api/notas?competencia=2020-01`)).body, {
      competencia: "2020-01",
      notas: [],
      total: 0,
      quantidade: 0,
    });
  });
});

test("sem nenhuma Nota a lista de competências é vazia", async () => {
  await comNotas(
    async ({ base }) => {
      assert.deepEqual((await json(`${base}/api/notas/competencias`)).body, []);
    },
    async () => {},
  );
});

test("as rotas de Notas não alteram o banco nem a pasta de saída", async () => {
  await comNotas(async ({ base, dbPath, outputDir }) => {
    const retrato = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return {
          schema: db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
          vendas: db.prepare("SELECT * FROM vendas ORDER BY id").all(),
          notas: db.prepare("SELECT * FROM notas ORDER BY id").all(),
          tentativas: db.prepare("SELECT * FROM tentativas_emissao ORDER BY id").all(),
          arquivos: readdirSync(outputDir, { recursive: true }).sort(),
        };
      } finally {
        db.close();
      }
    };
    const antes = retrato();

    assert.equal((await json(`${base}/api/notas/competencias`)).status, 200);
    assert.equal((await json(`${base}/api/notas?competencia=2026-09`)).status, 200);
    assert.equal((await json(`${base}/api/notas?competencia=2026-10`)).status, 200);

    assert.deepEqual(retrato(), antes);
    assert.equal(existsSync(join(outputDir, "ndps.json")), false);
  });
});

test("sem outputDir injetado a pasta vem do NFSE_OUTPUT_DIR do .env, como no config", async () => {
  await comNotas(async ({ root, dbPath, outputDir }) => {
    const envPath = join(root, ".env");
    await writeFile(envPath, `NFSE_OUTPUT_DIR='${outputDir}'\n`);
    const anterior = process.env["NFSE_OUTPUT_DIR"];
    delete process.env["NFSE_OUTPUT_DIR"];
    const server = createServer(createPainelApp({ panelPort: 0, dbPath, envPath }));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const { body } = await json(`http://127.0.0.1:${port}/api/notas?competencia=2026-08`);
      assert.equal(body.total, 10);
      assert.equal(process.env["NFSE_OUTPUT_DIR"], undefined, "ler o .env não pode mudar o ambiente");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (anterior !== undefined) process.env["NFSE_OUTPUT_DIR"] = anterior;
    }
  });
});
