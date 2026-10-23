import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buscarNotaPorVenda,
  conciliarComChave,
  conciliarRejeitada,
  concluirEmissao,
  criarEReservarEmissao,
  detectarDuplicatasNotas,
  initDb,
  listarReservasAbandonadas,
  marcarTentativaAveriguar,
  marcarTentativaRejeitada,
  proximoNDPS,
  recolocarVendaNaFila,
  reservarEmissao,
  upsertVenda,
  listVendas,
  marcarStatus,
  registrarNota,
  criarContrato,
  atualizarContrato,
  listContratos,
  desativarContrato,
  gerarVendasDoMes,
  gerarVendasDoMesDetalhado,
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

const outputDirTeste = mkdtempSync(join(tmpdir(), "nfse-store-output-"));

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

test("upsertVenda parcial preserva contrato_id existente", () => {
  initDb(":memory:");
  const contratoId = criarContrato(contratoBase());
  upsertVenda({ ...vendaBase("venda-contrato"), contrato_id: contratoId });
  upsertVenda(vendaBase("venda-contrato"));
  assert.equal(porId("venda-contrato").contrato_id, contratoId);
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

test("marcarStatus mascara CPF e CNPJ antes de gravar a mensagem de erro", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-1"));
  marcarStatus(
    "venda-1",
    "erro",
    "Falha para CPF 111.444.777-35 e CNPJ 11.444.777/0001-61",
  );

  const erro = porId("venda-1").erro;
  assert.equal(erro, "Falha para CPF 111...35 e CNPJ 114...61");
  assert.doesNotMatch(erro ?? "", /111\.444\.777-35|11\.444\.777\/0001-61/);
});

test("marcarStatus mapeia cada status para a fila correta", () => {
  initDb(":memory:");
  const casos: Array<[string, string | null]> = [
    ["pendente_cadastro", "pendente_cadastro"],
    ["aguardando_garantia", "aguardando_garantia"],
    ["excecao", "excecao"],
    ["pronta_sem_endereco", "pronta_sem_endereco"],
    ["erro", null],
  ];
  for (const [status, filaEsperada] of casos) {
    upsertVenda(vendaBase(`venda-${status}`));
    marcarStatus(`venda-${status}`, status as Venda["status"]);
    assert.equal(porId(`venda-${status}`).fila, filaEsperada, `status ${status}`);
  }
});

test("marcarStatus põe Venda a verificar fora da fila com mensagem de conciliação", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-sem-chave"));

  marcarStatus(
    "venda-sem-chave",
    "a_verificar",
    "Chave de acesso não encontrada; conciliação manual necessária.",
  );

  const venda = porId("venda-sem-chave");
  assert.equal(venda.status, "a_verificar");
  assert.equal(venda.fila, null);
  assert.match(venda.erro ?? "", /conciliação manual/i);
});

test("upsertVenda não recoloca na fila uma Venda a verificar", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-em-conciliacao"));
  marcarStatus("venda-em-conciliacao", "a_verificar", "Conciliação manual necessária.");

  upsertVenda({ ...vendaBase("venda-em-conciliacao"), status: "pronta", fila: "pronta" });

  const venda = porId("venda-em-conciliacao");
  assert.equal(venda.status, "a_verificar");
  assert.equal(venda.fila, null);
});

test("upsertVenda atualiza o motivo de uma Venda que continua a verificar", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-motivo"));
  marcarStatus("venda-motivo", "a_verificar", "Motivo inicial.");

  upsertVenda({
    ...vendaBase("venda-motivo"),
    status: "a_verificar",
    fila: null,
    erro: "Falha de leitura do XML; conciliação manual necessária.",
  });

  assert.match(porId("venda-motivo").erro ?? "", /Falha de leitura do XML/);
});

test("upsertVenda não recoloca Venda em erro na fila automaticamente", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-erro"));
  marcarStatus("venda-erro", "erro", "Rejeitada pela SEFIN.");

  upsertVenda({ ...vendaBase("venda-erro"), status: "pronta", fila: "pronta" });

  const venda = porId("venda-erro");
  assert.equal(venda.status, "erro");
});

test("registrarNota recusa Chave de acesso que não tenha 50 dígitos", () => {
  initDb(":memory:");

  assert.throws(
    () => registrarNota({ chave_acesso: "SIM-42-venda", ndps: 42 }),
    /Chave de acesso válida de 50 dígitos/,
  );
});

test("schema impede duas Notas para a mesma Venda", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-unica"));
  registrarNota({ chave_acesso: "5".repeat(50), ndps: 1, id_venda: "venda-unica" });

  assert.throws(
    () => registrarNota({ chave_acesso: "6".repeat(50), ndps: 2, id_venda: "venda-unica" }),
    /UNIQUE constraint failed/i,
  );
});

function bancoLegado(path: string, duplicata = false): void {
  const legado = new DatabaseSync(path);
  legado.exec(`
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_venda TEXT UNIQUE NOT NULL,
      fonte TEXT,
      produto TEXT,
      valor REAL,
      data_venda TEXT,
      discriminacao TEXT,
      cpf_cnpj TEXT,
      nome TEXT,
      email TEXT,
      telefone TEXT,
      cep TEXT,
      cidade TEXT,
      uf TEXT,
      bairro TEXT,
      rua TEXT,
      numero TEXT,
      complemento TEXT,
      dias_garantia INTEGER,
      estrangeiro INTEGER DEFAULT 0,
      fila TEXT,
      status TEXT,
      erro TEXT,
      criada_em TEXT,
      atualizada_em TEXT
    );
    CREATE TABLE notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_acesso TEXT UNIQUE NOT NULL,
      ndps INTEGER NOT NULL,
      id_venda TEXT REFERENCES vendas(id_venda),
      xml_path TEXT,
      pdf_path TEXT,
      emitida_em TEXT
    );
  `);
  legado.prepare(
    "INSERT INTO vendas (id_venda, status, fila) VALUES (?, 'emitida', 'pronta')",
  ).run("venda-legada");
  const inserirNota = legado.prepare(
    "INSERT INTO notas (chave_acesso, ndps, id_venda) VALUES (?, ?, ?)",
  );
  inserirNota.run("1".repeat(50), 7, "venda-legada");
  if (duplicata) inserirNota.run("2".repeat(50), 8, "venda-legada");
  legado.close();
}

function bancoLegadoAntesDosTickets(path: string): void {
  bancoLegado(path);
  const legado = new DatabaseSync(path);
  legado.exec(`
    CREATE TABLE contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_doc TEXT NOT NULL,
      cliente_nome TEXT NOT NULL,
      cliente_email TEXT,
      valor REAL NOT NULL,
      xdesc_serv TEXT NOT NULL,
      ctrib_nac TEXT NOT NULL,
      cnbs TEXT,
      dia_do_mes INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1,
      criado_em TEXT
    );
  `);
  legado.prepare(`
    INSERT INTO contratos
      (cliente_doc, cliente_nome, valor, xdesc_serv, ctrib_nac, cnbs, dia_do_mes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "11144477735", "Cliente contrato legado", 100, "Servico legado", "080201", "122051900", 1,
  );
  legado.prepare(`
    INSERT INTO vendas (id_venda, fonte, produto, valor, cpf_cnpj, nome, fila, status)
    VALUES (?, 'contrato', ?, ?, ?, ?, 'pronta', 'pronta')
  `).run("contrato-1-2026-03", "Contrato: Servico legado", 100, "11144477735", "Cliente contrato legado");
  legado.close();
}

test("detectarDuplicatasNotas é pura e lista cada Venda uma vez", () => {
  assert.deepEqual(
    detectarDuplicatasNotas([
      { id_venda: "venda-2" },
      { id_venda: "venda-1" },
      { id_venda: "venda-2" },
      { id_venda: null },
      { id_venda: "venda-1" },
    ]),
    ["venda-1", "venda-2"],
  );
});

test("migração em cópia faz backup, mantém linhas e é idempotente", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-migracao-"));
  const legado = join(root, "legado.db");
  const copia = join(root, "emissor.db");
  bancoLegado(legado);
  copyFileSync(legado, copia);

  const db = initDb(copia);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM vendas").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notas").get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tentativas_emissao'",
    ).get() as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'notas_id_venda_unico'",
    ).get() as { n: number }).n,
    1,
  );

  const backups = () => readdirSync(root).filter((name) => name.startsWith("emissor.db.bak-"));
  assert.equal(backups().length, 1);

  db.exec("DROP INDEX tentativas_emissao_venda_aberta");
  initDb(copia);
  assert.equal(backups().length, 2);

  initDb(copia);
  assert.equal(backups().length, 2);
});

test("legado anterior aos tickets #6 e #9 migra com um backup e para no segundo init", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-migracao-dois-tickets-"));
  const caminho = join(root, "emissor.db");
  bancoLegadoAntesDosTickets(caminho);

  const primeira = initDb(caminho);
  const backups = () => readdirSync(root).filter((name) => name.startsWith("emissor.db.bak-"));
  assert.equal(backups().length, 1);
  for (const nome of ["cliente_cmun", "cliente_cep", "cliente_rua", "cliente_numero", "cliente_complemento", "cliente_bairro"]) {
    assert.ok(
      (primeira.prepare("PRAGMA table_info(contratos)").all() as Array<{ name: string }>)
        .some((coluna) => coluna.name === nome),
      `coluna ausente: ${nome}`,
    );
  }
  assert.deepEqual(
    { ...primeira.prepare("SELECT contrato_id, cmun, cep, rua, numero, bairro FROM vendas WHERE id_venda = ?")
      .get("contrato-1-2026-03") as Record<string, unknown> },
    {
      contrato_id: 1,
      cmun: null,
      cep: null,
      rua: null,
      numero: null,
      bairro: null,
    },
  );
  assert.equal(
    (primeira.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_vendas_contrato_id'").get() as { n: number }).n,
    1,
  );

  const segunda = initDb(caminho);
  assert.equal(backups().length, 1);
  assert.equal((segunda.prepare("SELECT COUNT(*) AS n FROM contratos").get() as { n: number }).n, 1);
});

test("backfill de Contrato só toca Venda elegível durante a migração #9", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-migracao-backfill-"));
  const caminho = join(root, "emissor.db");
  const legado = new DatabaseSync(caminho);
  legado.exec(`
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, id_venda TEXT UNIQUE NOT NULL, fonte TEXT,
      produto TEXT, valor REAL, data_venda TEXT, discriminacao TEXT, cpf_cnpj TEXT,
      nome TEXT, email TEXT, telefone TEXT, cep TEXT, cidade TEXT, uf TEXT, bairro TEXT,
      rua TEXT, numero TEXT, complemento TEXT, dias_garantia INTEGER, estrangeiro INTEGER DEFAULT 0,
      fila TEXT, status TEXT, erro TEXT, criada_em TEXT, atualizada_em TEXT
    );
    CREATE TABLE notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chave_acesso TEXT UNIQUE NOT NULL,
      ndps INTEGER NOT NULL, id_venda TEXT, xml_path TEXT, pdf_path TEXT, emitida_em TEXT
    );
    CREATE TABLE contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_doc TEXT NOT NULL, cliente_nome TEXT NOT NULL,
      cliente_email TEXT, valor REAL NOT NULL, xdesc_serv TEXT NOT NULL, ctrib_nac TEXT NOT NULL,
      cnbs TEXT, dia_do_mes INTEGER NOT NULL, ativo INTEGER DEFAULT 1, criado_em TEXT,
      cliente_cmun TEXT, cliente_cep TEXT, cliente_rua TEXT, cliente_numero TEXT,
      cliente_complemento TEXT, cliente_bairro TEXT
    );
  `);
  const contrato = legado.prepare(`
    INSERT INTO contratos
      (cliente_doc, cliente_nome, valor, xdesc_serv, ctrib_nac, cnbs, dia_do_mes,
       cliente_cmun, cliente_cep, cliente_rua, cliente_numero, cliente_complemento, cliente_bairro)
    VALUES (?, ?, 100, ?, '080201', '122051900', 1, '3509502', '13000000', 'Rua', '1', 'Sala', 'Centro')
  `);
  contrato.run("11444777000161", "Contrato 1", "Servico 1");
  contrato.run("11444777000162", "Contrato 2", "Servico 2");
  legado.prepare("UPDATE contratos SET id = 12 WHERE id = 2").run();
  const venda = legado.prepare(`
    INSERT INTO vendas (id_venda, fonte, produto, valor, fila, status)
    VALUES (?, ?, ?, 100, 'pronta', ?)
  `);
  venda.run("contrato-1-2026-10", "contrato", "Contrato: Servico 1", "pronta");
  venda.run("contrato-12-2026-10", "contrato", "Contrato: Servico 2", "pronta");
  venda.run("contrato-1-2026-11", "contrato", "Contrato: Servico 1", "emitindo");
  venda.run("contrato-12-2026-11", "contrato", "Contrato: Servico 2", "a_verificar");
  venda.run("contrato-1-2026-12", "contrato", "Contrato: Servico 1", "simulada");
  venda.run("contrato-1-2026-13", "lastlink", "Contrato: Servico 1", "pronta");
  legado.close();

  const primeira = initDb(caminho);
  const buscar = (database: DatabaseSync, id: string) => ({ ...database.prepare(`
    SELECT contrato_id, cmun, cep, rua, numero, complemento, bairro
    FROM vendas WHERE id_venda = ?
  `).get(id) as Record<string, unknown> });
  assert.deepEqual(buscar(primeira, "contrato-1-2026-10"), {
    contrato_id: 1, cmun: "3509502", cep: "13000000", rua: "Rua", numero: "1", complemento: "Sala", bairro: "Centro",
  });
  assert.deepEqual(buscar(primeira, "contrato-12-2026-10"), {
    contrato_id: 12, cmun: "3509502", cep: "13000000", rua: "Rua", numero: "1", complemento: "Sala", bairro: "Centro",
  });
  for (const id of ["contrato-1-2026-11", "contrato-12-2026-11", "contrato-1-2026-12", "contrato-1-2026-13"]) {
    assert.deepEqual(buscar(primeira, id), {
      contrato_id: null, cmun: null, cep: null, rua: null, numero: null, complemento: null, bairro: null,
    }, id);
  }

  primeira.prepare(`
    INSERT INTO vendas (id_venda, fonte, produto, valor, fila, status)
    VALUES ('contrato-1-2026-14', 'contrato', 'Contrato: Servico 1', 100, 'pronta', 'pronta')
  `).run();
  const esperadoElegivel = buscar(primeira, "contrato-1-2026-10");
  const segunda = initDb(caminho);
  assert.deepEqual(buscar(segunda, "contrato-1-2026-10"), esperadoElegivel);
  assert.deepEqual({ ...segunda.prepare(`
    SELECT contrato_id, cmun, cep FROM vendas WHERE id_venda = 'contrato-1-2026-14'
  `).get() as Record<string, unknown> }, { contrato_id: null, cmun: null, cep: null });
});

test("banco novo não cria backup de migração", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-migracao-novo-"));
  const caminho = join(root, "emissor.db");
  initDb(caminho);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith("emissor.db.bak-")),
    [],
  );
});

test("migração aborta sem alterar cópia que tem Venda com duas Notas", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-migracao-duplicada-"));
  const caminho = join(root, "emissor.db");
  bancoLegado(caminho, true);

  assert.throws(
    () => initDb(caminho),
    /venda-legada.*mais de uma Nota.*resolva/i,
  );
  const db = new DatabaseSync(caminho);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notas").get() as { n: number }).n, 2);
  assert.equal(readdirSync(root).filter((name) => name.startsWith("emissor.db.bak-")).length, 0);
  db.close();
});

test("proximo nDPS considera Notas, tentativas e o piso legado", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-ndps-"));
  const output = join(root, "output");
  mkdirSync(output);
  writeFileSync(join(output, "ndps.json"), JSON.stringify({ proximoNDPS: 20 }));
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-ndps"));
  database.prepare(
    "INSERT INTO notas (chave_acesso, ndps) VALUES (?, ?)",
  ).run("3".repeat(50), 4);
  database.prepare(
    "INSERT INTO tentativas_emissao (id_venda, ndps, estado, criada_em, atualizada_em) VALUES (?, ?, 'rejeitada', ?, ?)",
  ).run("venda-ndps", 9, new Date().toISOString(), new Date().toISOString());
  assert.equal(proximoNDPS(output), 20);
});

test("proximo nDPS ignora NFSE_OUTPUT_DIR vazio e não usa o cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-ndps-vazio-"));
  const cwdAnterior = process.cwd();
  const outputAnterior = process.env["NFSE_OUTPUT_DIR"];
  const piso = 999_999_999;
  mkdirSync(join(root, "  "));
  writeFileSync(join(root, "ndps.json"), JSON.stringify({ proximoNDPS: piso }));
  writeFileSync(join(root, "  ", "ndps.json"), JSON.stringify({ proximoNDPS: piso }));

  try {
    for (const valor of ["", "  "]) {
      process.chdir(root);
      process.env["NFSE_OUTPUT_DIR"] = valor;
      initDb(":memory:");
      // A pasta padrão pode ter resultados reais; o que importa é não ler o piso do cwd.
      assert.ok(proximoNDPS() < piso);
    }
  } finally {
    process.chdir(cwdAnterior);
    if (outputAnterior === undefined) delete process.env["NFSE_OUTPUT_DIR"];
    else process.env["NFSE_OUTPUT_DIR"] = outputAnterior;
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("proximo nDPS considera arquivos de resultado e retorna o maior mais um", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-ndps-resultado-"));
  const output = join(root, "output");
  mkdirSync(output);
  writeFileSync(join(output, "resultado-ndps-57.json"), "{}");
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-ndps-resultado"));
  database.prepare("INSERT INTO notas (chave_acesso, ndps) VALUES (?, ?)")
    .run("8".repeat(50), 56);

  assert.equal(proximoNDPS(output), 58);
});

test("proximo nDPS bloqueia piso inválido em vez de assumir 1", () => {
  const valoresInvalidos: unknown[] = [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "7"];
  for (const [indice, valor] of valoresInvalidos.entries()) {
    const root = mkdtempSync(join(tmpdir(), `nfse-ndps-invalido-${indice}-`));
    const output = join(root, "output");
    mkdirSync(output);
    writeFileSync(join(output, "ndps.json"), JSON.stringify({ proximoNDPS: valor }));
    initDb(":memory:");
    assert.throws(() => proximoNDPS(output), /piso nDPS inválido/i);
  }
});

test("proximo nDPS só considera resultado cujo nome tem nDPS decimal", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-ndps-arquivo-invalido-"));
  const output = join(root, "output");
  mkdirSync(output);
  writeFileSync(join(output, "resultado-ndps-57.json"), "{}");
  writeFileSync(join(output, "resultado-ndps-58.5.json"), "{}");
  writeFileSync(join(output, "resultado-ndps-nao-numerico.json"), "{}");
  initDb(":memory:");
  assert.equal(proximoNDPS(output), 58);
});

test("reserva atômica põe a Venda em emitindo e não reserva duas vezes", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-reserva"));

  const primeira = reservarEmissao("venda-reserva", outputDirTeste);
  const segunda = reservarEmissao("venda-reserva", outputDirTeste);

  assert.ok(primeira);
  assert.equal(segunda, null);
  assert.equal(primeira?.ndps, 1);
  assert.equal(porId("venda-reserva").status, "emitindo");
});

test("criação e reserva não expõem Venda nova como pronta", () => {
  initDb(":memory:");
  const tentativa = criarEReservarEmissao(vendaBase("venda-sem-janela"));

  assert.ok(tentativa);
  const venda = porId("venda-sem-janela");
  assert.equal(venda.status, "emitindo");
  assert.equal(venda.fila, null);
});

test("nDPS de tentativa rejeitada não é reutilizado no retry explícito", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-retry-ndps"));
  const primeira = reservarEmissao("venda-retry-ndps", outputDirTeste);
  assert.ok(primeira);
  marcarTentativaRejeitada("venda-retry-ndps", "Rejeitada pela SEFIN.");

  database.prepare("UPDATE vendas SET status = 'pronta', fila = 'pronta' WHERE id_venda = ?")
    .run("venda-retry-ndps");
  const segunda = reservarEmissao("venda-retry-ndps", outputDirTeste);

  assert.ok(segunda);
  assert.equal(segunda.ndps, primeira.ndps + 1);
});

test("finalizar emissão grava Venda emitida e Nota na mesma operação", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-final"));
  const tentativa = reservarEmissao("venda-final", outputDirTeste);
  assert.ok(tentativa);

  concluirEmissao({
    id_venda: "venda-final",
    ndps: tentativa.ndps,
    chave_acesso: "4".repeat(50),
  });

  assert.equal(porId("venda-final").status, "emitida");
  assert.ok(buscarNotaPorVenda("venda-final"));
});

test("conclusão tardia fecha tentativa a verificar e grava Nota na mesma transação", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-tardia"));
  const tentativa = reservarEmissao("venda-tardia", outputDirTeste);
  assert.ok(tentativa);
  marcarTentativaAveriguar("venda-tardia", "Resposta chegou depois da varredura.");

  concluirEmissao({ id_venda: "venda-tardia", ndps: tentativa.ndps, chave_acesso: "7".repeat(50) });

  assert.equal(porId("venda-tardia").status, "emitida");
  assert.equal(
    (database.prepare("SELECT estado FROM tentativas_emissao WHERE id_venda = ?").get("venda-tardia") as { estado: string }).estado,
    "concluida",
  );
  assert.ok(buscarNotaPorVenda("venda-tardia"));
});

test("conclusão recusa nDPS diferente da tentativa da Venda", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-ndps-diferente"));
  const tentativa = reservarEmissao("venda-ndps-diferente", outputDirTeste);
  assert.ok(tentativa);

  assert.throws(
    () => concluirEmissao({ id_venda: "venda-ndps-diferente", ndps: tentativa.ndps + 1, chave_acesso: "8".repeat(50) }),
    /conflito/i,
  );
});

test("conclusão recusa nDPS que pertence à tentativa de outra Venda", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-ndps-a"));
  upsertVenda(vendaBase("venda-ndps-b"));
  const primeira = reservarEmissao("venda-ndps-a", outputDirTeste);
  const segunda = reservarEmissao("venda-ndps-b", outputDirTeste);
  assert.ok(primeira);
  assert.ok(segunda);

  assert.throws(
    () => concluirEmissao({ id_venda: "venda-ndps-a", ndps: segunda.ndps, chave_acesso: "9".repeat(50) }),
    /conflito/i,
  );
});

test("conclusão recusa tentativa já rejeitada", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-rejeitada-tardia"));
  const tentativa = reservarEmissao("venda-rejeitada-tardia", outputDirTeste);
  assert.ok(tentativa);
  marcarTentativaRejeitada("venda-rejeitada-tardia", "Falha antes do envio.");

  assert.throws(
    () => concluirEmissao({ id_venda: "venda-rejeitada-tardia", ndps: tentativa.ndps, chave_acesso: "0".repeat(50) }),
    /conflito/i,
  );
});

test("conclusão recusa tentativa concluída com outra Chave", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-concluida-outra-chave"));
  const tentativa = reservarEmissao("venda-concluida-outra-chave", outputDirTeste);
  assert.ok(tentativa);
  database.prepare("UPDATE tentativas_emissao SET estado = 'concluida', chave_acesso = ? WHERE id = ?")
    .run("1".repeat(50), tentativa.id);

  assert.throws(
    () => concluirEmissao({ id_venda: "venda-concluida-outra-chave", ndps: tentativa.ndps, chave_acesso: "2".repeat(50) }),
    /conflito/i,
  );
});

test("falha ou timeout fica a verificar e não volta para a fila", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-timeout"));
  assert.ok(reservarEmissao("venda-timeout", outputDirTeste));

  marcarTentativaAveriguar("venda-timeout", "SEFIN pode ter autorizado; conciliação necessária.");

  const venda = porId("venda-timeout");
  assert.equal(venda.status, "a_verificar");
  assert.equal(venda.fila, null);
  assert.equal(listVendas({ fila: "pronta" }).some((v) => v.id_venda === "venda-timeout"), false);
  assert.equal(reservarEmissao("venda-timeout", outputDirTeste), null);
});

test("retry de tentativa rejeitada volta status e fila juntos e reserva novamente", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-retry"));
  assert.ok(reservarEmissao("venda-retry", outputDirTeste));
  marcarTentativaRejeitada("venda-retry", "Falha antes do envio.");

  assert.deepEqual(recolocarVendaNaFila("venda-retry"), { ok: true });
  assert.equal(porId("venda-retry").status, "pronta");
  assert.equal(porId("venda-retry").fila, "pronta");
  assert.ok(reservarEmissao("venda-retry", outputDirTeste));
});

test("Venda em erro legada sem tentativa não pode ser reenviada", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-erro-legada"));
  marcarStatus("venda-erro-legada", "erro", "timeout legado");

  const resultado = recolocarVendaNaFila("venda-erro-legada");
  assert.deepEqual(resultado, { ok: false, motivo: "sem_tentativa_rejeitada" });
  assert.equal(porId("venda-erro-legada").status, "erro");
});

test("reservas antigas viram a verificar com aviso", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-abandonada"));
  const tentativa = reservarEmissao("venda-abandonada", outputDirTeste);
  assert.ok(tentativa);
  database.prepare("UPDATE tentativas_emissao SET atualizada_em = ? WHERE id = ?")
    .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), tentativa.id);
  const avisos: string[] = [];

  assert.deepEqual(listarReservasAbandonadas(new Date(), (aviso) => avisos.push(aviso)), ["venda-abandonada"]);
  assert.equal(porId("venda-abandonada").status, "a_verificar");
  assert.equal(porId("venda-abandonada").fila, null);
  assert.match(avisos[0] ?? "", /abandonada/i);
});

test("conciliação com Chave fecha tentativa e registra Nota", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-conciliar"));
  assert.ok(reservarEmissao("venda-conciliar", outputDirTeste));
  marcarTentativaAveriguar("venda-conciliar", "Resposta ambígua.");

  conciliarComChave("venda-conciliar", "9".repeat(50));

  assert.equal(porId("venda-conciliar").status, "emitida");
  assert.ok(buscarNotaPorVenda("venda-conciliar"));
  assert.equal(
    (database.prepare("SELECT estado FROM tentativas_emissao WHERE id_venda = ?").get("venda-conciliar") as { estado: string }).estado,
    "concluida",
  );
});

test("conciliação rejeitada fecha tentativa e deixa retry disponível", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-conciliar-rejeitada"));
  assert.ok(reservarEmissao("venda-conciliar-rejeitada", outputDirTeste));
  marcarTentativaAveriguar("venda-conciliar-rejeitada", "Resposta ambígua.");

  conciliarRejeitada("venda-conciliar-rejeitada");

  assert.equal(porId("venda-conciliar-rejeitada").status, "erro");
  assert.equal(porId("venda-conciliar-rejeitada").fila, null);
  assert.deepEqual(recolocarVendaNaFila("venda-conciliar-rejeitada"), { ok: true });
});

test("conciliação manual aceita reserva emitindo e avisa conferência na SEFIN", () => {
  const avisos: string[] = [];
  const avisoOriginal = console.warn;
  console.warn = (...args: unknown[]) => avisos.push(args.map(String).join(" "));
  try {
    initDb(":memory:");
    upsertVenda(vendaBase("venda-conciliar-reservada"));
    assert.ok(reservarEmissao("venda-conciliar-reservada", outputDirTeste));

    conciliarComChave("venda-conciliar-reservada", "8".repeat(50));

    assert.equal(porId("venda-conciliar-reservada").status, "emitida");
    assert.ok(buscarNotaPorVenda("venda-conciliar-reservada"));

    upsertVenda(vendaBase("venda-rejeitada-reservada"));
    assert.ok(reservarEmissao("venda-rejeitada-reservada", outputDirTeste));
    conciliarRejeitada("venda-rejeitada-reservada");
    assert.equal(porId("venda-rejeitada-reservada").status, "erro");
    assert.deepEqual(recolocarVendaNaFila("venda-rejeitada-reservada"), { ok: true });
  } finally {
    console.warn = avisoOriginal;
  }
  assert.equal(avisos.length, 2);
  assert.match(avisos.join("\n"), /declara.*conferido na SEFIN/i);
});

test("finalização idempotente aceita mesma Nota e explicita conflitos", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-idempotente"));
  const tentativa = reservarEmissao("venda-idempotente", outputDirTeste);
  assert.ok(tentativa);
  const chave = "1".repeat(50);
  const nota = { id_venda: "venda-idempotente", ndps: tentativa.ndps, chave_acesso: chave };
  concluirEmissao(nota);
  assert.doesNotThrow(() => concluirEmissao(nota));
  assert.throws(
    () => concluirEmissao({ ...nota, chave_acesso: "2".repeat(50) }),
    /conflito/i,
  );

  upsertVenda(vendaBase("venda-outra"));
  const outra = reservarEmissao("venda-outra", outputDirTeste);
  assert.ok(outra);
  assert.throws(
    () => concluirEmissao({ id_venda: "venda-outra", ndps: outra.ndps, chave_acesso: chave }),
    /conflito/i,
  );
});

test("marcarStatus não manda emitindo para a fila nem simulação sobrescreve a reserva", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-emitindo-status"));
  database.prepare("UPDATE vendas SET status = 'emitindo', fila = NULL WHERE id_venda = ?")
    .run("venda-emitindo-status");

  assert.throws(
    () => marcarStatus("venda-emitindo-status", "simulada"),
    /transição da Venda/i,
  );

  const venda = porId("venda-emitindo-status");
  assert.equal(venda.status, "emitindo");
  assert.equal(venda.fila, null);
});

test("marcarStatus atualiza Venda legada com status nulo durante a simulação", () => {
  const database = initDb(":memory:");
  upsertVenda(vendaBase("venda-status-nulo"));
  database.prepare("UPDATE vendas SET status = NULL, fila = 'pronta' WHERE id_venda = ?")
    .run("venda-status-nulo");

  marcarStatus("venda-status-nulo", "simulada");

  assert.equal(porId("venda-status-nulo").status, "simulada");
  assert.equal(porId("venda-status-nulo").fila, "pronta");
});

test("transições de tentativa falham quando nenhum UPDATE muda uma linha", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-transicao-ausente"));

  assert.throws(
    () => marcarTentativaAveriguar("venda-transicao-ausente", "resposta ambígua"),
    /transição da tentativa/i,
  );
  assert.throws(
    () => marcarTentativaRejeitada("venda-transicao-ausente", "falha antes do envio"),
    /transição da tentativa/i,
  );
});

test("migração usa VACUUM INTO e backup contém linha mantida no WAL", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-migracao-wal-"));
  const caminho = join(root, "emissor.db");
  bancoLegado(caminho);
  const escritor = new DatabaseSync(caminho);
  escritor.exec("PRAGMA journal_mode=WAL");
  escritor.prepare("INSERT INTO vendas (id_venda, status, fila) VALUES (?, 'pronta', 'pronta')")
    .run("venda-wal");

  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  assert.match(source, /VACUUM INTO/);
  assert.doesNotMatch(source, /wal_checkpoint|copyFileSync/);
  initDb(caminho);
  escritor.close();

  const backup = readdirSync(root).find((name) => name.startsWith("emissor.db.bak-"));
  assert.ok(backup);
  const copia = new DatabaseSync(join(root, backup));
  assert.equal((copia.prepare("SELECT COUNT(*) AS n FROM vendas").get() as { n: number }).n, 2);
  copia.close();
});

test("marcarStatus emitindo usa fila nula", () => {
  initDb(":memory:");
  upsertVenda(vendaBase("venda-emitindo-fila"));
  marcarStatus("venda-emitindo-fila", "emitindo");
  assert.equal(porId("venda-emitindo-fila").fila, null);
});

// ─── Contratos recorrentes ───────────────────────────────────────────────────

function contratoBase(overrides: Partial<Contrato> = {}): Omit<Contrato, "id" | "criado_em"> {
  return {
    cliente_doc: "11444777000161",
    cliente_nome: "EMPRESA EXEMPLO LTDA",
    cliente_cmun: "3509502",
    cliente_cep: "13000000",
    cliente_rua: "Rua Exemplo",
    cliente_numero: "100",
    cliente_bairro: "Centro",
    valor: 500,
    xdesc_serv: "Servico de exemplo.",
    ctrib_nac: "080201",
    cnbs: "122051900",
    dia_do_mes: 10,
    ...overrides,
  };
}

test("migração idempotente preserva contrato legado e adiciona campos do ticket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nfse-legacy-"));
  const dbPath = join(dir, "legacy.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_venda TEXT UNIQUE NOT NULL,
      fonte TEXT,
      produto TEXT,
      valor REAL,
      data_venda TEXT,
      discriminacao TEXT,
      cpf_cnpj TEXT,
      nome TEXT,
      email TEXT,
      telefone TEXT,
      cep TEXT,
      cidade TEXT,
      uf TEXT,
      bairro TEXT,
      rua TEXT,
      numero TEXT,
      complemento TEXT,
      dias_garantia INTEGER,
      estrangeiro INTEGER DEFAULT 0,
      fila TEXT,
      status TEXT,
      erro TEXT,
      criada_em TEXT,
      atualizada_em TEXT
    );
    CREATE TABLE contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_doc TEXT NOT NULL,
      cliente_nome TEXT NOT NULL,
      cliente_email TEXT,
      valor REAL NOT NULL,
      xdesc_serv TEXT NOT NULL,
      ctrib_nac TEXT NOT NULL,
      cnbs TEXT,
      dia_do_mes INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1,
      criado_em TEXT,
      cliente_cmun TEXT,
      cliente_cep TEXT,
      cliente_rua TEXT,
      cliente_numero TEXT,
      cliente_complemento TEXT,
      cliente_bairro TEXT
    );
    CREATE TABLE notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_acesso TEXT UNIQUE NOT NULL,
      ndps INTEGER NOT NULL,
      id_venda TEXT,
      xml_path TEXT,
      pdf_path TEXT,
      emitida_em TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO contratos
      (cliente_doc, cliente_nome, valor, xdesc_serv, ctrib_nac, cnbs, dia_do_mes,
       cliente_cmun, cliente_cep, cliente_rua, cliente_numero, cliente_complemento, cliente_bairro)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "11144477735", "Cliente legado", 100, "Servico legado", "080201", "122051900", 1,
    "3509502", "13000000", "Rua Legada", "10", "Sala 2", "Centro",
  );
  legacy.prepare(`
    INSERT INTO vendas (id_venda, fonte, valor, cpf_cnpj, nome, fila, status)
    VALUES (?, 'contrato', 100, ?, ?, 'pronta', 'pronta')
  `).run("contrato-1-2026-01", "11144477735", "Cliente legado");
  legacy.prepare(`
    INSERT INTO vendas (id_venda, fonte, valor, cpf_cnpj, nome, fila, status)
    VALUES (?, 'contrato', 100, ?, ?, 'pronta', 'emitida')
  `).run("contrato-1-2026-02", "11144477735", "Cliente legado");
  legacy.prepare(`
    INSERT INTO notas (chave_acesso, ndps, id_venda) VALUES (?, ?, ?)
  `).run("12345678901234567890123456789012345678901234567890", 2, "contrato-1-2026-02");
  legacy.close();

  try {
    const db = initDb(dbPath);
    const contratoColunas = (db.prepare("PRAGMA table_info(contratos)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    const vendaColunas = (db.prepare("PRAGMA table_info(vendas)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const nome of ["cliente_cmun", "cliente_cep", "cliente_rua", "cliente_numero", "cliente_complemento", "cliente_bairro"]) {
      assert.ok(contratoColunas.includes(nome), `coluna ausente: ${nome}`);
    }
    assert.ok(vendaColunas.includes("contrato_id"));
    assert.equal(
      (db.prepare("SELECT cliente_nome FROM contratos").get() as { cliente_nome: string }).cliente_nome,
      "Cliente legado",
    );
    const migrada = db.prepare(`
      SELECT contrato_id, cmun, cep, rua, numero, complemento, bairro
      FROM vendas WHERE id_venda = ?
    `).get("contrato-1-2026-01") as {
      contrato_id: number;
      cmun: string;
      cep: string;
      rua: string;
      numero: string;
      complemento: string;
      bairro: string;
    };
    assert.deepEqual({ ...migrada }, {
      contrato_id: 1,
      cmun: "3509502",
      cep: "13000000",
      rua: "Rua Legada",
      numero: "10",
      complemento: "Sala 2",
      bairro: "Centro",
    });
    const emitida = db.prepare(`
      SELECT contrato_id, cmun, cep FROM vendas WHERE id_venda = ?
    `).get("contrato-1-2026-02") as { contrato_id: number | null; cmun: string | null; cep: string | null };
    assert.deepEqual({ ...emitida }, { contrato_id: null, cmun: null, cep: null });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_vendas_contrato_id'").get() as { n: number }).n,
      1,
    );

    const segunda = initDb(dbPath);
    assert.equal((segunda.prepare("SELECT COUNT(*) AS n FROM contratos").get() as { n: number }).n, 1);
    const migradaDeNovo = segunda.prepare("SELECT contrato_id, cmun, complemento FROM vendas WHERE id_venda = ?")
      .get("contrato-1-2026-01") as { contrato_id: number; cmun: string; complemento: string };
    assert.deepEqual(
      { ...migradaDeNovo },
      { contrato_id: 1, cmun: "3509502", complemento: "Sala 2" },
    );
  } finally {
    initDb(":memory:");
    await rm(dir, { recursive: true, force: true });
  }
});

test("criarContrato exige endereço completo e cNBS", () => {
  initDb(":memory:");
  assert.throws(
    () => criarContrato(contratoBase({ cliente_bairro: "" })),
    /Contrato .*cliente_bairro/,
  );
  assert.throws(
    () => criarContrato(contratoBase({ cnbs: "" })),
    /Contrato .*cNBS/,
  );
});

test("gerarVendasDoMes pula Contrato legado incompleto e gera os válidos", () => {
  const db = initDb(":memory:");
  const incompleto = criarContrato(contratoBase({ cliente_nome: "Contrato legado" }));
  db.prepare("UPDATE contratos SET cliente_cep = NULL, cnbs = NULL WHERE id = ?").run(incompleto);
  const valido = criarContrato(contratoBase({ cliente_nome: "Contrato válido" }));

  const resultado = gerarVendasDoMesDetalhado("2026-03");
  assert.equal(resultado.novas, 1);
  assert.deepEqual(resultado.pulados, [{
    id: incompleto,
    cliente_nome: "Contrato legado",
    campos_faltantes: ["cliente_cep", "cNBS"],
  }]);
  assert.equal(listVendas().filter((v) => v.contrato_id === valido).length, 1);
});

test("atualizarContrato completa legado e permite gerar Venda", () => {
  const db = initDb(":memory:");
  const id = criarContrato(contratoBase({ cliente_nome: "Contrato legado" }));
  db.prepare(`
    UPDATE contratos
    SET cliente_cmun = NULL, cliente_cep = NULL, cliente_rua = NULL,
        cliente_numero = NULL, cliente_bairro = NULL, cnbs = NULL
    WHERE id = ?
  `).run(id);

  atualizarContrato(id, {
    cliente_cmun: "3509502",
    cliente_cep: "13000000",
    cliente_rua: "Rua Corrigida",
    cliente_numero: "20",
    cliente_complemento: "Fundos",
    cliente_bairro: "Centro",
    cnbs: "122051900",
  });

  assert.equal(gerarVendasDoMes("2026-03"), 1);
  assert.equal(porId("contrato-1-2026-03").rua, "Rua Corrigida");
});

test("gerarVendasDoMes grava endereço e contrato_id na Venda", () => {
  initDb(":memory:");
  const id = criarContrato(contratoBase());
  assert.equal(gerarVendasDoMes("2026-03"), 1);
  const [venda] = listVendas().filter((v) => v.fonte === "contrato");
  assert.equal(venda.contrato_id, id);
  assert.deepEqual(
    {
      cmun: venda.cmun,
      cep: venda.cep,
      rua: venda.rua,
      numero: venda.numero,
      bairro: venda.bairro,
    },
    {
      cmun: "3509502",
      cep: "13000000",
      rua: "Rua Exemplo",
      numero: "100",
      bairro: "Centro",
    },
  );
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

test("gerarVendasDoMes recusa competencia com mes ou ano nao numerico", () => {
  initDb(":memory:");
  // Regressao: antes o guard so checava a presenca do separador "-", entao
  // "marco-2026" passava, parseInt("marco") virava NaN e data_venda saia
  // corrompida em silencio em vez de falhar aqui.
  assert.throws(() => gerarVendasDoMes("marco-2026"), /Competência inválida/);
  assert.throws(() => gerarVendasDoMes("2026-mar"), /Competência inválida/);
});

test("gerarVendasDoMes recusa mes fora do intervalo 01-12", () => {
  initDb(":memory:");
  assert.throws(() => gerarVendasDoMes("2026-00"), /Competência inválida/);
  assert.throws(() => gerarVendasDoMes("2026-13"), /Competência inválida/);
});
