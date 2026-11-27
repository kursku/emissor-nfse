/**
 * Teste do helper puro de mascara.ts, usado por server.ts para mascarar
 * CPF/CNPJ nas respostas do painel (/api/vendas nunca devolve o documento
 * completo). Testado via mascara.ts diretamente para manter este teste puro.
 */
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mascaraDoc, mascararDocumentos } from "../mascara.js";
import { createPainelApp, iniciarPainel, lerAmbiente, PAINEL_TOKEN_HEADER } from "./server.js";
import { initDb, proximoNDPS, reservarEmissao, upsertVenda } from "../store.js";

test("mascaraDoc mostra so os 3 primeiros e 2 ultimos digitos de um CPF", () => {
  assert.equal(mascaraDoc("111.444.777-35"), "111...35");
});

test("mascaraDoc mostra so os 3 primeiros e 2 ultimos digitos de um CNPJ", () => {
  assert.equal(mascaraDoc("11.444.777/0001-61"), "114...61");
});

test("mascaraDoc devolve vazio para documento ausente", () => {
  assert.equal(mascaraDoc(undefined), "");
  assert.equal(mascaraDoc(null), "");
  assert.equal(mascaraDoc(""), "");
});

test("mascaraDoc nao mascara documento curto demais (menos de 5 digitos)", () => {
  assert.equal(mascaraDoc("1234"), "1234");
});

test("mascararDocumentos remove CPF e CNPJ completos de uma mensagem", () => {
  const texto = "CPF 111.444.777-35 e CNPJ 11.444.777/0001-61";
  const seguro = mascararDocumentos(texto);

  assert.equal(seguro, "CPF 111...35 e CNPJ 114...61");
  assert.doesNotMatch(seguro, /111\.444\.777-35|11\.444\.777\/0001-61/);
});

async function ouvir(app: ReturnType<typeof createPainelApp>, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("servidor sem porta TCP");
  return { server, port: address.port };
}

async function fechar(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("ouvir falha imediatamente quando a porta está ocupada", async () => {
  const ocupado = createServer();
  await new Promise<void>((resolve, reject) => {
    ocupado.once("error", reject);
    ocupado.listen(0, "127.0.0.1", resolve);
  });
  const address = ocupado.address();
  if (!address || typeof address === "string") throw new Error("servidor ocupado sem porta TCP");

  try {
    await assert.rejects(
      ouvir(createPainelApp({ panelPort: 0 }), address.port),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "EADDRINUSE");
        return true;
      },
    );
  } finally {
    await fechar(ocupado);
  }
});

async function pedir(port: number, path: string, options: { method?: string; token?: string; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: {
        Host: `localhost:${port}`,
        ...(options.token ? { [PAINEL_TOKEN_HEADER]: options.token } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function tokenDaPagina(port: number): Promise<string> {
  const response = await pedir(port, "/");
  assert.equal(response.status, 200);
  const token = /name="painel-token" content="([^"]+)"/.exec(response.body)?.[1];
  assert.ok(token);
  return token;
}

const pedidoValido = JSON.stringify({
  nDPS: "1",
  tomador: {
    CNPJ: "11444777000161",
    xNome: "Tomador",
    end: { cMun: "3509502", CEP: "13000000", xLgr: "Rua", nro: "1", xBairro: "Centro" },
  },
  xDescServ: "Servico",
  vServ: 100,
  cTribNac: "080201",
  cNBS: "122051900",
  cIndOp: "100301",
  cClassTrib: "000001",
});

test("subir o painel não carrega o bundle nativo", () => {
  const packagePath = join(process.cwd(), "package.json");
  const bloquearLibxml = `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(packagePath)});
    const Module = require('node:module');
    const carregar = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'libxmljs2') throw new Error('libxmljs2 bloqueado no startup');
      return carregar.call(this, request, parent, isMain);
    };
  `;
  const resultado = spawnSync(
    process.execPath,
    [
      "--import", "tsx",
      "--import", `data:text/javascript,${encodeURIComponent(bloquearLibxml)}`,
      "--input-type=module",
      "--eval", "await import('./src/painel/server.ts'); console.log('server-ok')",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /server-ok/);
});

test("defaults usa NFSE_OUTPUT_DIR quando o emissor não é injetado", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-defaults-"));
  const dbPath = join(root, "emissor.db");
  const antigoOutputDir = process.env["NFSE_OUTPUT_DIR"];
  process.env["NFSE_OUTPUT_DIR"] = root;
  writeFileSync(join(root, "ndps.json"), JSON.stringify({ proximoNDPS: 42 }));
  const app = createPainelApp({ panelPort: 0, dbPath });
  const { server, port } = await ouvir(app);

  try {
    const response = await pedir(port, "/api/defaults");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).nDPS, "42");
  } finally {
    if (antigoOutputDir === undefined) delete process.env["NFSE_OUTPUT_DIR"];
    else process.env["NFSE_OUTPUT_DIR"] = antigoOutputDir;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaults e emissão usam o mesmo nDPS com e sem outputDir injetado", async () => {
  const ambienteAnterior = process.env["NFSE_AMBIENTE"];
  const modoAnterior = process.env["EMITIR_REAL"];
  const outputAnterior = process.env["NFSE_OUTPUT_DIR"];
  const variaveisConfig = {
    NFSE_CNPJ: "11444777000161",
    NFSE_COD_MUNICIPIO: "3509502",
    NFSE_CERT_PATH: "certificado-inexistente",
    NFSE_CERT_PASSWORD: "teste",
    NFSE_IM: "1",
    NFSE_UF: "SP",
    NFSE_AMBIENTE: "2",
  };

  async function conferir(outputDirInjetado: boolean): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "nfse-server-ndps-"));
    const outputDir = join(root, "arquivos");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "ndps.json"), JSON.stringify({ proximoNDPS: 42 }));
    const dbPath = join(root, "emissor.db");
    const antigoLoadEnvFile = process.loadEnvFile;
    let recebido: string | undefined;
    let outputDirDaReserva: string | undefined;
    process.env["EMITIR_REAL"] = "1";
    process.env["NFSE_AMBIENTE"] = "2";
    for (const [nome, valor] of Object.entries(variaveisConfig)) process.env[nome] = valor;
    if (outputDirInjetado) {
      delete process.env["NFSE_OUTPUT_DIR"];
    } else {
      delete process.env["NFSE_OUTPUT_DIR"];
      process.loadEnvFile = (() => {
        process.env["NFSE_OUTPUT_DIR"] = outputDir;
      }) as typeof process.loadEnvFile;
    }
    const app = createPainelApp({
      panelPort: 0,
      dbPath,
      ambiente: 1,
      agora: new Date("2026-12-01T03:00:00Z"),
      ...(outputDirInjetado ? { outputDir } : {}),
      exigirBundlePatchado: () => {},
      criarEReservarEmissao: (venda, dir) => {
        outputDirDaReserva = dir;
        return {
          id: 1,
          id_venda: venda.id_venda,
          ndps: 42,
          estado: "reservada",
          chave_acesso: null,
          criada_em: new Date().toISOString(),
          atualizada_em: new Date().toISOString(),
        };
      },
      emitirNfse: async (input) => {
        recebido = input.nDPS;
        throw new Error("falha local de teste");
      },
      marcarTentativaAveriguar: () => {},
    });
    const { server, port } = await ouvir(app);

    try {
      const defaults = await pedir(port, "/api/defaults");
      assert.equal(defaults.status, 200);
      const token = await tokenDaPagina(port);
      const emissao = await pedir(port, "/api/emitir", {
        method: "POST",
        token,
        body: pedidoValido,
      });
      assert.equal(emissao.status, 502);
      assert.equal(recebido, JSON.parse(defaults.body).nDPS);
      assert.equal(outputDirDaReserva, outputDir);
    } finally {
      process.loadEnvFile = antigoLoadEnvFile;
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      initDb(":memory:");
      rmSync(root, { recursive: true, force: true });
    }
  }

  try {
    await conferir(true);
    await conferir(false);
  } finally {
    if (ambienteAnterior === undefined) delete process.env["NFSE_AMBIENTE"];
    else process.env["NFSE_AMBIENTE"] = ambienteAnterior;
    if (modoAnterior === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = modoAnterior;
    if (outputAnterior === undefined) delete process.env["NFSE_OUTPUT_DIR"];
    else process.env["NFSE_OUTPUT_DIR"] = outputAnterior;
    for (const nome of Object.keys(variaveisConfig)) delete process.env[nome];
  }
});

test("painel com emissor injetado recusa ambiente 1 antes da implantação", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-layout-"));
  const dbPath = join(root, "emissor.db");
  const antigoModo = process.env["EMITIR_REAL"];
  const logs: string[] = [];
  const antigoError = console.error;
  process.env["EMITIR_REAL"] = "1";
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  let chamadas = 0;
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    ambiente: 1,
    agora: new Date("2026-12-01T02:59:59Z"),
    outputDir: join(root, "arquivos"),
    exigirBundlePatchado: () => {},
    emitirNfse: async () => {
      chamadas++;
      return {};
    },
  });
  const { server, port } = await ouvir(app);

  try {
    const response = await pedir(port, "/api/emitir", {
      method: "POST",
      token: await tokenDaPagina(port),
      body: pedidoValido,
    });
    assert.equal(response.status, 502);
    assert.equal(chamadas, 0);
    assert.match(logs.join("\n"), /NFSE_AMBIENTE=1 recusado até 2026-12-01/);
  } finally {
    console.error = antigoError;
    if (antigoModo === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = antigoModo;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("painel recusa modo real na produção restrita antes de reservar ou emitir", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-restrita-"));
  const dbPath = join(root, "emissor.db");
  const outputDir = join(root, "arquivos");
  mkdirSync(outputDir);
  writeFileSync(join(outputDir, "ndps.json"), JSON.stringify({ proximoNDPS: 42 }));
  const antigoModo = process.env["EMITIR_REAL"];
  process.env["EMITIR_REAL"] = "1";
  let reservas = 0;
  let chamadas = 0;
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir,
    ambiente: 2,
    criarEReservarEmissao: () => {
      reservas++;
      throw new Error("reserva não deveria ser chamada");
    },
    emitirNfse: async () => {
      chamadas++;
      throw new Error("emissor não deveria ser chamado");
    },
  });
  const { server, port } = await ouvir(app);

  try {
    const response = await pedir(port, "/api/emitir", {
      method: "POST",
      token: await tokenDaPagina(port),
      body: pedidoValido,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.body), {
      erro: "MODO REAL recusado: NFSE_AMBIENTE=2 é produção restrita e não gera nota fiscal real.",
    });
    assert.equal(reservas, 0);
    assert.equal(chamadas, 0);
    const database = initDb(dbPath);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM vendas").get() as { n: number }).n, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM tentativas_emissao").get() as { n: number }).n, 0);
    assert.equal(proximoNDPS(outputDir), 42);
  } finally {
    if (antigoModo === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = antigoModo;
    await fechar(server);
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("painel verifica o bundle antes de chamar o emissor", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-bundle-"));
  const dbPath = join(root, "emissor.db");
  const antigoModo = process.env["EMITIR_REAL"];
  process.env["EMITIR_REAL"] = "1";
  const ordem: string[] = [];
  const logAnterior = console.log;
  console.log = (...args: unknown[]) => {
    if (args.join(' ').startsWith('PRODUÇÃO (NFSE_AMBIENTE=1)')) ordem.push('aviso');
  };
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    ambiente: 1,
    agora: new Date("2026-12-01T03:00:00Z"),
    outputDir: join(root, "arquivos"),
    exigirBundlePatchado: () => ordem.push("bundle"),
    criarEReservarEmissao: (venda) => ({
      id: 1,
      id_venda: venda.id_venda,
      ndps: 1,
      estado: "reservada",
      chave_acesso: null,
      criada_em: new Date().toISOString(),
      atualizada_em: new Date().toISOString(),
    }),
    emitirNfse: async () => {
      ordem.push("emissor");
      throw new Error("falha local de teste");
    },
    marcarTentativaAveriguar: () => {},
  });
  const { server, port } = await ouvir(app);

  try {
    const response = await pedir(port, "/api/emitir", {
      method: "POST",
      token: await tokenDaPagina(port),
      body: pedidoValido,
    });
    assert.equal(response.status, 502);
    assert.deepEqual(ordem, ["bundle", "aviso", "emissor"]);
  } finally {
    console.log = logAnterior;
    if (antigoModo === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = antigoModo;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("subir o painel não recupera reserva abandonada", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-sem-varredura-"));
  const dbPath = join(root, "emissor.db");
  try {
    const database = initDb(dbPath);
    upsertVenda({ id_venda: "venda-painel-abandonada", produto: "produto", fila: "pronta", status: "pronta" });
    const tentativa = reservarEmissao("venda-painel-abandonada", root);
    assert.ok(tentativa);
    database.prepare("UPDATE tentativas_emissao SET atualizada_em = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), tentativa.id);

    createPainelApp({ dbPath, panelPort: 0 });

    const estado = initDb(dbPath).prepare(
      "SELECT estado FROM tentativas_emissao WHERE id = ?",
    ).get(tentativa.id) as { estado: string };
    assert.equal(estado.estado, "reservada");
  } finally {
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("falha antes da reserva não marca tentativa nem Venda", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-sem-reserva-"));
  const dbPath = join(root, "emissor.db");
  const antigoModo = process.env["EMITIR_REAL"];
  process.env["EMITIR_REAL"] = "1";
  let marcas = 0;
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    ambiente: 1,
    agora: new Date("2026-12-01T03:00:00Z"),
    outputDir: join(root, "arquivos"),
    criarEReservarEmissao: () => { throw new Error("falha antes da reserva"); },
    marcarTentativaAveriguar: () => { marcas++; },
    marcarTentativaRejeitada: () => { marcas++; },
  });
  let server: Server | undefined;

  try {
    const listening = await ouvir(app);
    server = listening.server;
    const { port } = listening;
    const response = await pedir(port, "/api/emitir", {
      method: "POST",
      token: await tokenDaPagina(port),
      body: pedidoValido,
    });
    assert.equal(response.status, 502);
    assert.equal(marcas, 0);
    const database = initDb(dbPath);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM tentativas_emissao").get() as { n: number }).n, 0);
  } finally {
    if (antigoModo === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = antigoModo;
    if (server) await fechar(server);
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("falha ao gravar transição responde 500 e deixa a Venda para conferência", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-transicao-"));
  const dbPath = join(root, "emissor.db");
  const antigoModo = process.env["EMITIR_REAL"];
  process.env["EMITIR_REAL"] = "1";
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir: join(root, "arquivos"),
    emitirNfse: async () => ({}),
    marcarTentativaAveriguar: () => { throw new Error("banco indisponível"); },
  });
  let server: Server | undefined;

  try {
    const listening = await ouvir(app);
    server = listening.server;
    const { port } = listening;
    const response = await pedir(port, "/api/emitir", {
      method: "POST",
      token: await tokenDaPagina(port),
      body: pedidoValido,
    });
    assert.equal(response.status, 500);
    assert.match(response.body, /ficou para conferência/i);
    const venda = initDb(dbPath).prepare("SELECT status FROM vendas").get() as { status: string };
    assert.equal(venda.status, "emitindo");
  } finally {
    if (antigoModo === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = antigoModo;
    if (server) await fechar(server);
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("painel usa o nDPS devolvido pela reserva no erro persistido", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-server-ndps-reservado-"));
  const dbPath = join(root, "emissor.db");
  const antigoModo = process.env["EMITIR_REAL"];
  process.env["EMITIR_REAL"] = "1";
  const mensagens: string[] = [];
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir: join(root, "arquivos"),
    criarEReservarEmissao: (venda) => ({
      id: 1,
      id_venda: venda.id_venda,
      ndps: 77,
      estado: "reservada",
      chave_acesso: null,
      criada_em: new Date().toISOString(),
      atualizada_em: new Date().toISOString(),
    }),
    emitirNfse: async () => { throw new Error("falha local de teste"); },
    marcarTentativaAveriguar: (_idVenda, mensagem) => { mensagens.push(mensagem); },
  });
  let server: Server | undefined;

  try {
    const listening = await ouvir(app);
    server = listening.server;
    const { port } = listening;
    const response = await pedir(port, "/api/emitir", {
      method: "POST",
      token: await tokenDaPagina(port),
      body: pedidoValido,
    });
    assert.equal(response.status, 502);
    assert.match(mensagens.join("\n"), /nDPS=77/);
    assert.doesNotMatch(mensagens.join("\n"), /nDPS=1/);
  } finally {
    if (antigoModo === undefined) delete process.env["EMITIR_REAL"];
    else process.env["EMITIR_REAL"] = antigoModo;
    if (server) await fechar(server);
    initDb(":memory:");
    rmSync(root, { recursive: true, force: true });
  }
});

test("mascararDocumentos aceita separadores alternativos sem tocar na Chave de acesso", () => {
  const casos = [
    ["CPF com hífens", "111-444-777-35", "111...35"],
    ["CPF com espaços", "111 444 777 35", "111...35"],
    ["CNPJ com pontos e hífen", "11.444.777.0001-61", "114...61"],
    ["CNPJ com barras", "11/444/777/0001/61", "114...61"],
    ["CNPJ com espaços", "11 444 777 0001 61", "114...61"],
  ];

  for (const [descricao, documento, esperado] of casos) {
    assert.equal(mascararDocumentos(documento), esperado, descricao);
  }

  const chave = "9".repeat(50);
  assert.equal(mascararDocumentos(`Chave de acesso: ${chave}`), `Chave de acesso: ${chave}`);
});

test('painel registra somente resumo seguro no erro da SEFIN', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-25-server-'));
  const dbPath = join(root, 'emissor.db');
  const logs: string[] = [];
  const originalError = console.error;
  const originalMode = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  console.error = (...args: unknown[]) => logs.push(args.join(' '));

  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir: root,
    emitirNfse: async () => {
      const erro = Object.assign(new Error(
        'HTTP 400: {"nome":"Fulano","endereco":"Rua X","email":"a@b.com"}',
      ), {
        nfseErrorDetail: {
          raw: { nome: 'Fulano', endereco: 'Rua X', email: 'a@b.com' },
        },
      });
      throw erro;
    },
  });
  let httpServer: Server | undefined;

  async function request(path: string, method = 'GET', token?: string, body?: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      if (!httpServer) return reject(new Error('servidor não iniciado'));
      const address = httpServer.address();
      if (!address || typeof address === 'string') return reject(new Error('servidor sem porta'));
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: {
          Host: `localhost:${address.port}`,
          ...(token ? { [PAINEL_TOKEN_HEADER]: token } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  try {
    httpServer = (await ouvir(app)).server;
    const tokenResponse = await request('/');
    const token = /name="painel-token" content="([^"]+)"/.exec(tokenResponse.body)?.[1];
    assert.ok(token);

    const response = await request('/api/emitir', 'POST', token, JSON.stringify({
      xDescServ: 'Servico de teste.',
      vServ: 100,
      cTribNac: '080201',
      cNBS: '122051900',
      cIndOp: '100301',
      cClassTrib: '000001',
      tomador: {
        CNPJ: '11444777000161',
        xNome: 'Tomador',
        end: {
          cMun: '3509502',
          CEP: '13000000',
          xLgr: 'Rua Exemplo',
          nro: '100',
          xBairro: 'Centro',
        },
      },
    }));

    assert.equal(response.status, 502);
    const log = logs.join('\n');
    assert.match(log, /nDPS=1/);
    assert.match(log, /HTTP 400/);
    assert.doesNotMatch(log, /Fulano|Rua X|a@b\.com/);
  } finally {
    console.error = originalError;
    if (originalMode === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = originalMode;
    if (httpServer) await fechar(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

async function comPainel(
  deps: Parameters<typeof createPainelApp>[0],
  usar: (base: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nfse-moldura-"));
  const { server, port } = await ouvir(createPainelApp({ panelPort: 0, dbPath: join(root, "emissor.db"), ...deps }));
  try {
    await usar(`http://127.0.0.1:${port}`);
  } finally {
    await fechar(server);
    initDb(":memory:");
    await rm(root, { recursive: true, force: true });
  }
}

async function comVariaveis(nomes: string[], usar: () => Promise<void>): Promise<void> {
  const anteriores = nomes.map((nome) => [nome, process.env[nome]] as const);
  for (const nome of nomes) delete process.env[nome];
  try {
    await usar();
  } finally {
    for (const [nome, valor] of anteriores) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
}

type ConfigPainel = {
  modoSimulacao: boolean;
  ambiente: 1 | 2 | null;
  mensagemAmbiente: string;
  recusaModoReal: string | null;
};

async function configDoPainel(base: string): Promise<ConfigPainel> {
  return await (await fetch(`${base}/api/config`)).json() as ConfigPainel;
}

test("/api/config lidera com a simulacao, mostra o ambiente e a recusa do modo real", async () => {
  // Literais de proposito: usar os helpers da rota esconderia uma mudanca errada neles.
  const casos = [
    {
      configurado: "1", emitirReal: "", ambiente: 1, modoSimulacao: true,
      mensagemAmbiente: "SIMULAÇÃO: nenhuma nota será enviada à SEFIN. Ambiente configurado: PRODUÇÃO (NFSE_AMBIENTE=1).",
      recusaModoReal: null,
    },
    {
      configurado: "2", emitirReal: "", ambiente: 2, modoSimulacao: true,
      mensagemAmbiente: "SIMULAÇÃO: nenhuma nota será enviada à SEFIN. Ambiente configurado: HOMOLOGAÇÃO/PRODUÇÃO RESTRITA (NFSE_AMBIENTE=2).",
      recusaModoReal: null,
    },
    {
      // "0" é o que `nfse painel` sem --real define.
      configurado: "2", emitirReal: "0", ambiente: 2, modoSimulacao: true,
      mensagemAmbiente: "SIMULAÇÃO: nenhuma nota será enviada à SEFIN. Ambiente configurado: HOMOLOGAÇÃO/PRODUÇÃO RESTRITA (NFSE_AMBIENTE=2).",
      recusaModoReal: null,
    },
    {
      configurado: "1", emitirReal: "1", ambiente: 1, modoSimulacao: false,
      mensagemAmbiente: "PRODUÇÃO (NFSE_AMBIENTE=1): nota com validade fiscal.",
      recusaModoReal: null,
    },
    {
      configurado: "2", emitirReal: "1", ambiente: 2, modoSimulacao: false,
      mensagemAmbiente: "HOMOLOGAÇÃO/PRODUÇÃO RESTRITA (NFSE_AMBIENTE=2): sem validade fiscal; para produção configure NFSE_AMBIENTE=1.",
      recusaModoReal: "MODO REAL recusado: NFSE_AMBIENTE=2 é produção restrita e não gera nota fiscal real.",
    },
    {
      configurado: "3", emitirReal: "", ambiente: null, modoSimulacao: true,
      mensagemAmbiente: "SIMULAÇÃO: nenhuma nota será enviada à SEFIN. Ambiente desconhecido: confira NFSE_AMBIENTE (1 ou 2) no .env.",
      recusaModoReal: null,
    },
    {
      configurado: "3", emitirReal: "1", ambiente: null, modoSimulacao: false,
      mensagemAmbiente: "Ambiente desconhecido: confira NFSE_AMBIENTE (1 ou 2) no .env.",
      recusaModoReal: null,
    },
  ];
  await comVariaveis(["EMITIR_REAL", "NFSE_AMBIENTE"], async () => {
    for (const { configurado, emitirReal, ...esperado } of casos) {
      process.env["NFSE_AMBIENTE"] = configurado;
      process.env["EMITIR_REAL"] = emitirReal;
      await comPainel({}, async (base) => {
        const { ambiente, modoSimulacao, mensagemAmbiente, recusaModoReal } = await configDoPainel(base);
        assert.deepEqual({ ambiente, modoSimulacao, mensagemAmbiente, recusaModoReal }, esperado);
      });
    }
    process.env["NFSE_AMBIENTE"] = "2";
    await comPainel({ ambiente: 1 }, async (base) => {
      assert.equal((await configDoPainel(base)).ambiente, 1, "deps.ambiente vence o shell");
    });
  });
});

test("/api/config le o .env uma vez, na criacao do painel", async () => {
  const root = await mkdtemp(join(tmpdir(), "nfse-env-"));
  const envPath = join(root, ".env");
  try {
    await comVariaveis(["EMITIR_REAL", "NFSE_AMBIENTE"], async () => {
      writeFileSync(envPath, "NFSE_AMBIENTE=1\n");
      await comPainel({ envPath }, async (base) => {
        writeFileSync(envPath, "NFSE_AMBIENTE=2\n");
        process.env["NFSE_AMBIENTE"] = "2";
        assert.match((await configDoPainel(base)).mensagemAmbiente, /PRODUÇÃO \(NFSE_AMBIENTE=1\)/);
      });

      delete process.env["NFSE_AMBIENTE"];
      writeFileSync(envPath, "NFSE_AMBIENTE=3\n");
      await comPainel({ envPath }, async (base) => {
        assert.match((await configDoPainel(base)).mensagemAmbiente, /Ambiente desconhecido/);
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("variavel do shell vale mesmo com .env ilegivel", async () => {
  const root = await mkdtemp(join(tmpdir(), "nfse-env-"));
  try {
    assert.equal(lerAmbiente({ NFSE_AMBIENTE: "1" }, root), 1);
    assert.equal(lerAmbiente({ NFSE_AMBIENTE: "" }, root), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no Windows a chave do .env ignora caixa, como process.loadEnvFile", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nfse-env-"));
  const envPath = join(root, ".env");
  try {
    writeFileSync(envPath, "nfse_ambiente=1\n");
    assert.equal(lerAmbiente({}, envPath), 1);
    writeFileSync(envPath, "nfse_ambiente=2\nNfse_Ambiente=1\n");
    assert.equal(lerAmbiente({}, envPath), 1, "com chaves repetidas vale a mesma que loadEnvFile aplica");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/config expoe o ambiente resolvido, ou null quando desconhecido", async () => {
  const root = await mkdtemp(join(tmpdir(), "nfse-env-"));
  const envPath = join(root, ".env");
  try {
    await comVariaveis(["EMITIR_REAL", "NFSE_AMBIENTE"], async () => {
      process.env["EMITIR_REAL"] = "1";
      for (const [arquivo, esperado] of [["1", 1], ["2", 2], ["3", null]] as const) {
        writeFileSync(envPath, `NFSE_AMBIENTE=${arquivo}\n`);
        await comPainel({ envPath }, async (base) => {
          assert.equal((await configDoPainel(base)).ambiente, esperado);
        });
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lerAmbiente avisa quando o .env existe mas nao pode ser lido", async () => {
  const root = await mkdtemp(join(tmpdir(), "nfse-env-"));
  const erros: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { erros.push(args.join(" ")); };
  try {
    assert.equal(lerAmbiente({}, root), null);
    assert.equal(erros.length, 1);
    assert.ok(erros[0]?.includes("EISDIR"));
    assert.ok(erros[0]?.includes(root));
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiente do painel segue a precedencia da CLI sem carregar o .env no processo", async () => {
  const root = await mkdtemp(join(tmpdir(), "nfse-env-"));
  const envPath = join(root, ".env");
  try {
    writeFileSync(envPath, "NFSE_AMBIENTE=1\nEMITIR_REAL=1\n");
    const env: NodeJS.ProcessEnv = {};
    assert.equal(lerAmbiente(env, envPath), 1);
    assert.deepEqual(env, {}, "ler o aviso nao pode ligar EMITIR_REAL nem mudar o ambiente");
    assert.equal(lerAmbiente({ NFSE_AMBIENTE: "2" }, envPath), 2, "variavel do shell vence o .env");
    assert.equal(lerAmbiente({}, join(root, "nao-existe")), 2, "sem configuracao vale o padrao 2");
    assert.equal(lerAmbiente({ NFSE_AMBIENTE: " " }, envPath), 2);
    // Paridade com config.ts: variável vazia no shell impede o .env e cai no padrão.
    assert.equal(lerAmbiente({ NFSE_AMBIENTE: "" }, envPath), 2);
    assert.equal(lerAmbiente({ NFSE_AMBIENTE: "3" }, envPath), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("painel serve a moldura com as tres secoes para qualquer ?secao=", async () => {
  await comPainel({}, async (base) => {
    for (const secao of ["fechamento", "vendas", "emissao-manual"]) {
      const response = await fetch(`${base}/?secao=${secao}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /id="faixa-ambiente"/);
      for (const id of ["fechamento", "vendas", "emissao-manual"]) {
        assert.match(html, new RegExp(`<a href="\\?secao=${id}" data-secao="${id}">`), `link ${id}`);
        assert.match(html, new RegExp(`<section[^>]* data-secao="${id}"`), `secao ${id}`);
      }
    }
  });
});

test("createPainelApp aceita outputDir injetado", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "nfse-saida-"));
  try {
    writeFileSync(join(outputDir, "ndps.json"), JSON.stringify({ proximoNDPS: 42 }));
    await comPainel({ outputDir }, async (base) => {
      const defaults = await (await fetch(`${base}/api/defaults`)).json();
      assert.equal(defaults.nDPS, "42");
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("iniciarPainel registra erro e sai com codigo 1 quando a porta esta ocupada", async () => {
  const ocupado = createServer();
  await new Promise<void>((resolve, reject) => {
    ocupado.once("error", reject);
    ocupado.listen(0, "127.0.0.1", resolve);
  });
  const address = ocupado.address();
  if (!address || typeof address === "string") throw new Error("servidor ocupado sem porta TCP");

  const sinais = new EventEmitter();
  const logs: string[] = [];
  const erros: string[] = [];
  let resolverSaida: ((code: number) => void) | undefined;
  const saida = new Promise<number>((resolve) => { resolverSaida = resolve; });

  try {
    iniciarPainel(createPainelApp({ panelPort: 0 }), {
      port: address.port,
      signalTarget: sinais,
      onLog: (msg) => logs.push(msg),
      onError: (msg) => erros.push(msg),
      onExit: (code) => resolverSaida?.(code),
    });

    const codigo = await saida;
    assert.equal(codigo, 1);
    assert.deepEqual(logs, [], "nao deve imprimir banner quando o bind falha");
    assert.match(erros.join("\n"), new RegExp(`Falha ao iniciar painel em 127\\.0\\.0\\.1:${address.port}`));
    assert.equal(sinais.listenerCount("SIGTERM"), 0);
    assert.equal(sinais.listenerCount("SIGINT"), 0);
  } finally {
    await fechar(ocupado);
  }
});

test("iniciarPainel conclui requisicao em andamento ao receber SIGTERM e sai com codigo 0", async () => {
  const app = createPainelApp({ panelPort: 0 });
  let liberarResposta: (() => void) | undefined;
  let sinalizarRecebida: (() => void) | undefined;
  const requisicaoEmVoo = new Promise<void>((resolve) => { sinalizarRecebida = resolve; });
  app.get("/api/teste-shutdown", (_req, res) => {
    sinalizarRecebida?.();
    liberarResposta = () => res.status(200).json({ ok: true });
  });

  const sinais = new EventEmitter();
  const logs: string[] = [];
  const erros: string[] = [];
  const saidas: number[] = [];
  let resolverSaida: ((code: number) => void) | undefined;
  const saida = new Promise<number>((resolve) => { resolverSaida = resolve; });

  const server = iniciarPainel(app, {
    port: 0,
    shutdownTimeoutMs: 2_000,
    signalTarget: sinais,
    onLog: (msg) => logs.push(msg),
    onError: (msg) => erros.push(msg),
    onExit: (code) => {
      saidas.push(code);
      resolverSaida?.(code);
    },
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("servidor sem porta TCP");

  const respostaPromise = pedir(address.port, "/api/teste-shutdown");
  await requisicaoEmVoo;

  // Emite dois sinais seguidos para garantir idempotencia no encerramento.
  sinais.emit("SIGTERM", "SIGTERM");
  sinais.emit("SIGINT", "SIGINT");

  // Enquanto a requisicao estiver aberta, o servidor aguarda concluir.
  assert.deepEqual(saidas, []);

  liberarResposta?.();
  const resposta = await respostaPromise;
  const codigo = await saida;

  assert.equal(resposta.status, 200);
  assert.deepEqual(saidas, [0]);
  assert.equal(codigo, 0);
  assert.deepEqual(erros, []);
  assert.match(logs.join("\n"), new RegExp(`http://localhost:${address.port}`));
  assert.match(logs.join("\n"), /SIGTERM recebido; encerrando painel/);
  assert.match(logs.join("\n"), /Painel encerrado/);
  assert.equal(sinais.listenerCount("SIGTERM"), 0);
  assert.equal(sinais.listenerCount("SIGINT"), 0);
});

test("iniciarPainel forca saida com codigo 1 quando o encerramento excede o prazo", async () => {
  const app = createPainelApp({ panelPort: 0 });
  let sinalizarRecebida: (() => void) | undefined;
  const requisicaoTravada = new Promise<void>((resolve) => { sinalizarRecebida = resolve; });
  app.get("/api/teste-travado", (_req, _res) => {
    sinalizarRecebida?.();
  });

  const sinais = new EventEmitter();
  const erros: string[] = [];
  const saidas: number[] = [];
  let resolverSaida: ((code: number) => void) | undefined;
  const saida = new Promise<number>((resolve) => { resolverSaida = resolve; });

  const server = iniciarPainel(app, {
    port: 0,
    shutdownTimeoutMs: 80,
    signalTarget: sinais,
    onLog: () => { },
    onError: (msg) => erros.push(msg),
    onExit: (code) => {
      saidas.push(code);
      resolverSaida?.(code);
    },
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("servidor sem porta TCP");

  const erroCliente = pedir(address.port, "/api/teste-travado").catch((err: unknown) => err);
  await requisicaoTravada;

  sinais.emit("SIGTERM", "SIGTERM");
  const codigo = await saida;
  await erroCliente;

  assert.equal(codigo, 1);
  assert.deepEqual(saidas, [1]);
  assert.match(erros.join("\n"), /Encerramento excedeu 80ms; forçando saída/);
  assert.equal(sinais.listenerCount("SIGTERM"), 0);
  assert.equal(sinais.listenerCount("SIGINT"), 0);
});
