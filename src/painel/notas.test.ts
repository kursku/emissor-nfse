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
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
}

function xmlAutorizado({ chave, nNFSe, dCompet, xNome, doc, vServ }: Xml): string {
  return MODELO
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
