/**
 * Teste do helper puro de mascara.ts, usado por server.ts para mascarar
 * CPF/CNPJ nas respostas do painel (/api/vendas nunca devolve o documento
 * completo). Testado via mascara.ts diretamente para manter este teste puro.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mascaraDoc, mascararDocumentos } from "./mascara.js";
import { createPainelApp, PAINEL_TOKEN_HEADER } from "./server.js";
import { initDb, proximoNDPS, reservarEmissao, upsertVenda } from "./store.js";

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
      "--eval", "await import('./server.ts'); console.log('server-ok')",
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
    assert.deepEqual(ordem, ["bundle", "emissor"]);
  } finally {
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
