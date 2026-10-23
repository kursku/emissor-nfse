import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPainelApp,
  IMPORT_DIR,
  MAX_SESSION_TOKENS,
  PAINEL_TOKEN_HEADER,
  TOKEN_TTL_MS,
} from './server.js';
import { montarPayloadFormulario } from './painel-payload.mjs';
import { initDb, marcarStatus, marcarTentativaRejeitada, proximoNDPS, reservarEmissao, upsertVenda } from './store.js';

const panel = createPainelApp({ panelPort: 0 });
let server: Server | undefined;
let panelPort: number;
const painelHtml = readFileSync(new URL('./painel.html', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const EMISSAO_TESTE = {
  xDescServ: 'Servico de teste.',
  cTribNac: '080201',
  cNBS: '122051900',
  cIndOp: '100301',
  cClassTrib: '000001',
};
const TOMADOR_TESTE = {
  CNPJ: '11444777000161',
  xNome: 'Tomador',
  end: {
    cMun: '3509502',
    CEP: '13000000',
    xLgr: 'Rua Exemplo',
    nro: '100',
    xBairro: 'Centro',
  },
};

test('defaults do painel nao importa emissor', () => {
  const start = serverSource.indexOf("app.get('/api/defaults'");
  const end = serverSource.indexOf("app.get('/api/config'", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(serverSource.slice(start, end), /import\('\.\/emissor\.js'\)/);
});

test('emissao real do painel guarda o leiaute antes do banco', () => {
  const start = serverSource.indexOf("app.post('/api/emitir'");
  const guard = serverSource.indexOf('exigirLeiauteNovoPermitido(emissorConfig.ambiente)', start);
  const openDb = serverSource.indexOf('initDb(dbPath)', start);
  assert.ok(start >= 0 && guard > start && guard < openDb);
});

interface RequestOptions {
  method?: string;
  host?: string;
  origin?: string;
  token?: string;
  body?: string;
}

async function listen(app: ReturnType<typeof createPainelApp>, port = 0): Promise<{ server: Server; port: number }> {
  const httpServer = createServer(app);
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
      httpServer.off('error', onError);
      httpServer.off('listening', onListening);
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, '127.0.0.1');
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await close(httpServer).catch(() => undefined);
    throw new Error('servidor não expôs uma porta TCP após listen');
  }
  return { server: httpServer, port: address.port };
}

async function close(httpServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => httpServer.close((err) => err ? reject(err) : resolve()));
}

test('listen falha imediatamente quando a porta está ocupada', async () => {
  const ocupado = createServer();
  await new Promise<void>((resolve, reject) => {
    ocupado.once('error', reject);
    ocupado.listen(0, '127.0.0.1', resolve);
  });
  const address = ocupado.address();
  if (!address || typeof address === 'string') throw new Error('servidor de teste não expôs uma porta');

  try {
    await assert.rejects(
      listen(createPainelApp({ panelPort: 0 }), address.port),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'EADDRINUSE');
        return true;
      },
    );
  } finally {
    await close(ocupado);
  }
});

async function request(path: string, options: RequestOptions = {}, port = panelPort): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  const method = options.method ?? 'GET';
  const body = options.body ?? '';

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: options.host ?? `localhost:${port}`,
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.token ? { [PAINEL_TOKEN_HEADER]: options.token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function pageToken(port = panelPort): Promise<string> {
  const response = await request('/', {}, port);
  assert.equal(response.status, 200);
  const token = /name="painel-token" content="([^"]+)"/.exec(response.body)?.[1];
  assert.ok(token);
  return token;
}

before(async () => {
  const listening = await listen(panel);
  server = listening.server;
  panelPort = listening.port;
});

after(async () => {
  if (server) await close(server);
});

test('recusa Host estranho em todas as rotas do painel', async () => {
  const routes = [
    ['GET', '/'],
    ['GET', '/api/config'],
    ['GET', '/api/defaults'],
    ['GET', '/api/vendas/resumo'],
    ['GET', '/api/vendas'],
    ['POST', '/api/importar'],
    ['POST', '/api/simular'],
    ['POST', '/api/retry'],
    ['POST', '/api/emitir'],
  ] as const;

  for (const [method, path] of routes) {
    const response = await request(path, {
      method,
      host: `evil.example:${panelPort}`,
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
});

test('recusa Origin estranho mesmo com Host local', async () => {
  const response = await request('/api/config', {
    origin: `http://evil.example:${panelPort}`,
  });
  assert.equal(response.status, 403);
});

test('aceita os dois endereços locais na porta do painel', async () => {
  const response = await request('/api/config', {
    host: `127.0.0.1:${panelPort}`,
    origin: `http://127.0.0.1:${panelPort}`,
  });
  assert.equal(response.status, 200);
});

test('painel com porta fixa valida Host e Origin contra a porta configurada', async () => {
  // Com porta fixa o Host é comparado ao número configurado, não ao socket:
  // o servidor escuta em porta livre e a porta configurada nunca é aberta.
  const port = 40123;
  const listening = await listen(createPainelApp({ panelPort: port }));
  const outra = port + 1;
  try {
    const host = await request('/api/config', {
      host: `localhost:${outra}`,
    }, listening.port);
    assert.equal(host.status, 403);

    const origin = await request('/api/config', {
      origin: `http://127.0.0.1:${outra}`,
    }, listening.port);
    assert.equal(origin.status, 403);

    const real = await request('/api/config', {
      host: `localhost:${port}`,
      origin: `http://127.0.0.1:${port}`,
    }, listening.port);
    assert.equal(real.status, 200);
  } finally {
    await close(listening.server);
  }
});

test('panelPort 0 exige a porta real da requisição', async () => {
  const portaErrada = panelPort + 1;
  const host = await request('/api/config', {
    host: `localhost:${portaErrada}`,
  });
  assert.equal(host.status, 403);

  const origin = await request('/api/config', {
    origin: `http://127.0.0.1:${portaErrada}`,
  });
  assert.equal(origin.status, 403);

  const real = await request('/api/config', {
    host: `localhost:${panelPort}`,
    origin: `http://127.0.0.1:${panelPort}`,
  });
  assert.equal(real.status, 200);
});

test('bloqueia clickjacking com headers em toda resposta', async () => {
  const response = await request('/');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
});

test('linhas de venda nao geram handler inline com o id da Venda', () => {
  assert.match(painelHtml, /class="btn-retry"[^>]+data-id-venda=/);
  assert.match(painelHtml, /addEventListener\('click'/);
  assert.doesNotMatch(painelHtml, /onclick="doRetry/);
});

test('formulario manual aninha endereco e aceita CPF ou CNPJ do Tomador', () => {
  assert.deepEqual(montarPayloadFormulario({
    documento: '52998224725',
    xNome: 'PESSOA EXEMPLO',
    cMun: '3509502',
    CEP: '13000000',
    xLgr: 'Rua Exemplo',
    nro: '10',
    xCpl: 'Sala 2',
    xBairro: 'Centro',
    fone: '',
    email: 'pessoa@example.com',
    vServ: '100',
    xDescServ: 'Servico',
    cTribNac: '080201',
    cNBS: '122051900',
    cIndOp: '100301',
    cClassTrib: '000001',
  }), {
    vServ: 100,
    tomador: {
      CPF: '52998224725',
      xNome: 'PESSOA EXEMPLO',
      end: {
        cMun: '3509502', CEP: '13000000', xLgr: 'Rua Exemplo', nro: '10',
        xCpl: 'Sala 2', xBairro: 'Centro',
      },
      fone: undefined,
      email: 'pessoa@example.com',
    },
    xDescServ: 'Servico',
    cTribNac: '080201', cNBS: '122051900', cIndOp: '100301', cClassTrib: '000001',
  });
});

test('expira token de sessão depois do prazo', async () => {
  let agora = 1_000;
  const app = createPainelApp({ panelPort: 0, now: () => agora });
  const { server: httpServer, port } = await listen(app);

  try {
    const token = await pageToken(port);
    agora += TOKEN_TTL_MS;
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: '{}',
    }, port);
    assert.equal(response.status, 403);
  } finally {
    await close(httpServer);
  }
});

test('limita tokens ativos e descarta o mais antigo', async () => {
  const app = createPainelApp({ panelPort: 0, now: () => 1_000 });
  const { server: httpServer, port } = await listen(app);

  try {
    const tokens = [];
    for (let i = 0; i < MAX_SESSION_TOKENS + 1; i++) {
      tokens.push(await pageToken(port));
    }

    const antigo = await request('/api/emitir', {
      method: 'POST',
      token: tokens[0],
      body: '{}',
    }, port);
    assert.equal(antigo.status, 403);

    const atual = await request('/api/emitir', {
      method: 'POST',
      token: tokens[tokens.length - 1],
      body: '{}',
    }, port);
    assert.equal(atual.status, 409);
  } finally {
    await close(httpServer);
  }
});

test('exige token de sessão em toda rota POST', async () => {
  const routes = ['/api/importar', '/api/simular', '/api/retry', '/api/emitir'];
  for (const path of routes) {
    const missing = await request(path, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 403, `token ausente em ${path}`);

    const wrong = await request(path, { method: 'POST', token: 'token-errado', body: '{}' });
    assert.equal(wrong.status, 403, `token errado em ${path}`);
  }
});

test('modo simulação recusa emissão sem chamar o emissor', async () => {
  let chamadas = 0;
  const app = createPainelApp({
    panelPort: 0,
    emitirNfse: async () => {
      chamadas++;
      return {};
    },
  });
  const { server: httpServer, port } = await listen(app);
  const antigo = process.env['EMITIR_REAL'];
  delete process.env['EMITIR_REAL'];

  try {
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: '{}',
    }, port);
    assert.equal(response.status, 409);
    assert.equal(chamadas, 0);
  } finally {
    if (antigo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigo;
    await close(httpServer);
  }
});

test('painel recusa Tomador com dígito verificador inválido antes do emissor', async () => {
  let chamadas = 0;
  const antigo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    emitirNfse: async () => {
      chamadas++;
      return {};
    },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '1',
        vServ: 100,
        tomador: { ...TOMADOR_TESTE, CNPJ: '11444777000162' },
      }),
    }, port);
    assert.equal(response.status, 400);
    assert.match(response.body, /digito verificador/);
    assert.equal(chamadas, 0);
  } finally {
    if (antigo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigo;
    if (httpServer) await close(httpServer);
  }
});

test('painel aceita Tomador com CPF e entrega endereço aninhado ao emissor', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const antigo = process.env['EMITIR_REAL'];
  let recebido: { tomador: { CPF?: string; CNPJ?: string; end?: unknown } } | undefined;
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    outputDir,
    emitirNfse: async (input) => {
      recebido = input;
      return { chNFSe: '7'.repeat(50) };
    },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '1',
        vServ: 100,
        tomador: {
          CPF: '52998224725',
          xNome: 'PESSOA EXEMPLO',
          end: TOMADOR_TESTE.end,
        },
      }),
    }, port);
    assert.equal(response.status, 200);
    assert.equal(recebido?.tomador.CPF, '52998224725');
    assert.equal(recebido?.tomador.CNPJ, undefined);
    assert.deepEqual(recebido?.tomador.end, TOMADOR_TESTE.end);
  } finally {
    if (antigo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('recusa importação UNC e fora da pasta conhecida', async () => {
  let chamadas = 0;
  const app = createPainelApp({
    panelPort: 0,
    spawnTsx: async () => {
      chamadas++;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const { server: httpServer, port } = await listen(app);

  try {
    const token = await pageToken(port);
    const ausente = await request('/api/importar', {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    }, port);
    assert.equal(ausente.status, 400);
    assert.match(ausente.body, /Campo obrigatorio: path/);

    for (const path of ['\\\\servidor\\compartilhamento\\sales.xlsx', join(IMPORT_DIR, '..', 'sales.xlsx')]) {
      const response = await request('/api/importar', {
        method: 'POST',
        token,
        body: JSON.stringify({ path }),
      }, port);
      assert.equal(response.status, 400, path);
      assert.match(response.body, /Arquivo fora da pasta de importacao/);
    }
    assert.equal(chamadas, 0);
  } finally {
    await close(httpServer);
  }
});

test('passa ao importador o caminho absoluto resolvido e sem espaços', async () => {
  const importDir = await mkdtemp(join(tmpdir(), 'nfse-import-'));
  const recebido: string[] = [];
  await writeFile(join(importDir, 'sales.xlsx'), 'fixture');
  const app = createPainelApp({
    panelPort: 0,
    importDir,
    spawnTsx: async (_scriptPath, args) => {
      recebido.push(args[0]);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  const { server: httpServer, port } = await listen(app);

  try {
    const token = await pageToken(port);
    for (const path of ['sales.xlsx', '  sales.xlsx  ']) {
      const response = await request('/api/importar', {
        method: 'POST',
        token,
        body: JSON.stringify({ path }),
      }, port);
      assert.equal(response.status, 200);
    }
    assert.deepEqual(recebido, [join(importDir, 'sales.xlsx'), join(importDir, 'sales.xlsx')]);
  } finally {
    await close(httpServer);
    await rm(importDir, { recursive: true, force: true });
  }
});

test('recusa arquivo sob diretório symlink que aponta para fora', async (t) => {
  const importDir = await mkdtemp(join(tmpdir(), 'nfse-import-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'nfse-outside-'));
  let httpServer: Server | undefined;
  let chamadas = 0;

  try {
    await writeFile(join(outsideDir, 'sales.xlsx'), 'fixture');
    try {
      await symlink(outsideDir, join(importDir, 'atalho'), 'junction');
    } catch (err) {
      t.skip(`symlink indisponível neste Windows: ${String(err)}`);
      return;
    }

    const app = createPainelApp({
      panelPort: 0,
      importDir,
      spawnTsx: async () => {
        chamadas++;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/importar', {
      method: 'POST',
      token,
      body: JSON.stringify({ path: join(importDir, 'atalho', 'sales.xlsx') }),
    }, port);
    assert.equal(response.status, 400);
    assert.equal(chamadas, 0);
  } finally {
    if (httpServer) await close(httpServer);
    await rm(importDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('não devolve stdout ou stderr cru quando a importação falha', async () => {
  const importDir = await mkdtemp(join(tmpdir(), 'nfse-import-'));
  await writeFile(join(importDir, 'sales.xlsx'), 'fixture');
  const app = createPainelApp({
    panelPort: 0,
    importDir,
    spawnTsx: async () => ({ exitCode: 1, stdout: 'STDOUT_SECRETO', stderr: 'STDERR_SECRETO' }),
  });
  const { server: httpServer, port } = await listen(app);

  try {
    const token = await pageToken(port);
    const response = await request('/api/importar', {
      method: 'POST',
      token,
      body: JSON.stringify({ path: join(importDir, 'sales.xlsx') }),
    }, port);
    assert.equal(response.status, 500);
    assert.doesNotMatch(response.body, /STDOUT_SECRETO|STDERR_SECRETO/);
  } finally {
    await close(httpServer);
    await rm(importDir, { recursive: true, force: true });
  }
});

test('loga stdout e stderr de importação e simulação com documentos mascarados', async () => {
  const importDir = await mkdtemp(join(tmpdir(), 'nfse-import-'));
  const logs: string[] = [];
  const originalError = console.error;
  await writeFile(join(importDir, 'sales.xlsx'), 'fixture');
  const app = createPainelApp({
    panelPort: 0,
    importDir,
    spawnTsx: async (scriptPath) => {
      const tipo = scriptPath.includes('importar') ? 'importacao' : 'simulacao';
      return {
        exitCode: 1,
        stdout: `${tipo} stdout CPF 123.456.789-09 CNPJ 11.444.777/0001-61`,
        stderr: `${tipo} stderr CPF 12345678909 CNPJ 11444777000161`,
      };
    },
  });
  const { server: httpServer, port } = await listen(app);
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  try {
    const token = await pageToken(port);
    const importacao = await request('/api/importar', {
      method: 'POST',
      token,
      body: JSON.stringify({ path: join(importDir, 'sales.xlsx') }),
    }, port);
    const simulacao = await request('/api/simular', {
      method: 'POST',
      token,
      body: '{}',
    }, port);
    assert.equal(importacao.status, 500);
    assert.equal(simulacao.status, 500);
    const texto = logs.join('\n');
    assert.match(texto, /importacao stdout/);
    assert.match(texto, /simulacao stderr/);
    assert.match(texto, /123\.\.\.09/);
    assert.match(texto, /114\.\.\.61/);
    assert.doesNotMatch(texto, /123\.456\.789-09|12345678909|11\.444\.777\/0001-61|11444777000161/);
  } finally {
    console.error = originalError;
    await close(httpServer);
    await rm(importDir, { recursive: true, force: true });
  }
});

test('devolve códigos da SEFIN sem corpo cru e registra diagnóstico mascarado', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const logs: string[] = [];
  const originalError = console.error;
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    outputDir,
    emitirNfse: async () => {
      throw {
        message: 'Falha CPF 123.456.789-09',
        response: {
          data: {
            codigo: 'E0116',
            detalhe: 'CNPJ 11.444.777/0001-61',
          },
        },
      };
    },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '1',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.equal(response.status, 502);
    assert.match(response.body, /E0116/);
    assert.doesNotMatch(response.body, /detalhe|11\.444\.777\/0001-61|123\.456\.789-09/);
    const texto = logs.join('\n');
    assert.match(texto, /E0116/);
    assert.match(texto, /123\.\.\.09/);
    assert.match(texto, /114\.\.\.61/);
    assert.doesNotMatch(texto, /123\.456\.789-09|11\.444\.777\/0001-61/);
  } finally {
    console.error = originalError;
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('usa nfseErrorDetail para devolver o código e registrar diagnóstico seguro', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const logs: string[] = [];
  const originalError = console.error;
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    outputDir,
    dbPath: ':memory:',
    emitirNfse: async () => {
      throw {
        message: 'NFSE_Autorizacao: falha na autorização',
        nfseErrorDetail: {
          codigo: 'E0714',
          descricao: 'Assinatura da DPS rejeitada',
          complemento: 'CPF 123.456.789-09',
          statusHttp: 400,
          raw: { corpo: 'CORPO_SEFIN_SECRETO' },
        },
      };
    },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '1',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.deepEqual(JSON.parse(response.body), {
      erro: 'Falha na emissao',
      codigosSefin: ['E0714'],
    });
    const texto = logs.join('\n');
    assert.match(texto, /E0714/);
    assert.match(texto, /Assinatura da DPS rejeitada/);
    assert.match(texto, /123\.\.\.09/);
    assert.doesNotMatch(texto, /CORPO_SEFIN_SECRETO/);
  } finally {
    console.error = originalError;
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('não devolve stdout nem corpo bruto da SEFIN em respostas de sucesso', async () => {
  const importDir = await mkdtemp(join(tmpdir(), 'nfse-import-'));
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  await writeFile(join(importDir, 'sales.xlsx'), 'fixture');
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    importDir,
    outputDir,
    spawnTsx: async () => ({ exitCode: 0, stdout: 'RAW_PROCESS_OUTPUT', stderr: '' }),
    emitirNfse: async () => ({ codigo: 'E0116', detalhe: 'BODY_SEFIN_SECRETO' }),
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const importacao = await request('/api/importar', {
      method: 'POST',
      token,
      body: JSON.stringify({ path: join(importDir, 'sales.xlsx') }),
    }, port);
    const emissao = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '1',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.equal(importacao.status, 200);
    assert.doesNotMatch(importacao.body, /RAW_PROCESS_OUTPUT/);
    assert.equal(emissao.status, 200);
    assert.match(emissao.body, /E0116/);
    assert.doesNotMatch(emissao.body, /BODY_SEFIN_SECRETO|resultado/);
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(importDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('painel reconhece os dois campos de Chave de acesso e rejeita fallback falso', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const chave = '7'.repeat(50);
  const respostas: unknown[] = [
    { chNFSe: chave },
    { chaveAcesso: chave },
    { chaveAcesso: 'SIM-42-venda' },
  ];
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    outputDir,
    emitirNfse: async () => respostas.shift() ?? {},
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const body = JSON.stringify({
      ...EMISSAO_TESTE,
      nDPS: '42',
      vServ: 100,
      tomador: TOMADOR_TESTE,
    });

    const chNFSe = await request('/api/emitir', { method: 'POST', token, body }, port);
    const chaveAcesso = await request('/api/emitir', { method: 'POST', token, body }, port);
    const falsa = await request('/api/emitir', { method: 'POST', token, body }, port);

    assert.deepEqual(JSON.parse(chNFSe.body), { autorizada: true, chaveAcesso: chave });
    assert.deepEqual(JSON.parse(chaveAcesso.body), { autorizada: true, chaveAcesso: chave });
    assert.deepEqual(JSON.parse(falsa.body), { autorizada: false, chaveAcesso: null });
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('painel usa o XML autorizado do mesmo nDPS para avançar a sequência', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const autorizacao = join(outputDir, 'autorizacao');
  const chave = '8'.repeat(50);
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  await mkdir(autorizacao);
  await writeFile(join(outputDir, 'ndps.json'), JSON.stringify({ proximoNDPS: 42 }));
  await writeFile(
    join(autorizacao, `${chave}.xml`),
    '<NFSe><infDPS><nDPS>42</nDPS></infDPS></NFSe>',
  );
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    outputDir,
    emitirNfse: async () => ({}),
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '42',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.deepEqual(JSON.parse(response.body), { autorizada: true, chaveAcesso: chave });
    assert.deepEqual(
      JSON.parse(await readFile(join(outputDir, 'ndps.json'), 'utf8')),
      { proximoNDPS: 42 },
    );
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('painel não usa XML antigo quando a SEFIN rejeita o mesmo nDPS', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const autorizacao = join(outputDir, 'autorizacao');
  const chaveAntiga = '9'.repeat(50);
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  await mkdir(autorizacao);
  await writeFile(
    join(autorizacao, `${chaveAntiga}.xml`),
    '<NFSe><infDPS><nDPS>42</nDPS></infDPS></NFSe>',
  );
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    outputDir,
    emitirNfse: async () => ({ codigo: 'E0116' }),
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '42',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.deepEqual(JSON.parse(response.body), {
      autorizada: false,
      chaveAcesso: null,
      codigosSefin: ['E0116'],
    });
    assert.equal(await readFile(join(outputDir, 'ndps.json'), 'utf8').catch(() => null), null);
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('painel mantém autorização com Chave válida e alerta informativo', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-output-'));
  const chave = '6'.repeat(50);
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    dbPath: ':memory:',
    outputDir,
    emitirNfse: async () => ({ chNFSe: chave, mensagens: ['E0001 alerta'] }),
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '42',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.deepEqual(JSON.parse(response.body), {
      autorizada: true,
      chaveAcesso: chave,
      codigosSefin: ['E0001'],
    });
    assert.equal(await readFile(join(outputDir, 'ndps.json'), 'utf8').catch(() => null), null);
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('painel mantém o badge a_verificar com estilo próprio', () => {
  const html = readFileSync(new URL('./painel.html', import.meta.url), 'utf8');
  assert.match(html, /\.s-a_verificar\s*\{[^}]*background:/);
});

test('painel usa a fonte única de nDPS e registra Venda e Nota para a fila', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-ndps-'));
  const outputDir = join(root, 'saida-configurada');
  const dbPath = join(root, 'emissor.db');
  const chave = '5'.repeat(50);
  const recebido: string[] = [];
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  await mkdir(outputDir);
  await writeFile(join(outputDir, 'ndps.json'), JSON.stringify({ proximoNDPS: 40 }));
  const app = createPainelApp({
    panelPort: 0,
    outputDir,
    dbPath,
    emitirNfse: async (input) => {
      recebido.push(input.nDPS);
      return { chNFSe: chave };
    },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        nDPS: '999',
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);

    assert.equal(response.status, 200);
    assert.deepEqual(recebido, ['40']);
    assert.equal(proximoNDPS(outputDir), 41);

    const db = initDb(dbPath);
    const nota = db.prepare('SELECT ndps, id_venda FROM notas').get() as {
      ndps: number;
      id_venda: string;
    } | undefined;
    assert.ok(nota?.id_venda);
    assert.equal(nota.ndps, 40);
    const venda = db.prepare('SELECT id_venda, status FROM vendas WHERE id_venda = ?').get(nota.id_venda) as {
      id_venda: string;
      status: string;
    } | undefined;
    assert.equal(venda?.id_venda, nota.id_venda);
    assert.equal(venda?.status, 'emitida');
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

test('rejeição do painel não coloca a Venda na fila pronta nem permite retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-painel-rejeitada-'));
  const outputDir = join(root, 'output');
  const dbPath = join(root, 'emissor.db');
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  await mkdir(outputDir);
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir,
    emitirNfse: async () => ({ codigo: 'E0116' }),
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.equal(response.status, 200);

    const db = initDb(dbPath);
    const venda = db.prepare(
      'SELECT id_venda, fonte, produto, status, fila FROM vendas',
    ).get() as {
      id_venda: string;
      fonte: string;
      produto: string;
      status: string;
      fila: string | null;
    } | undefined;
    assert.ok(venda?.id_venda);
    assert.equal(venda.fonte, 'painel');
    assert.equal(venda.produto, 'painel');
    assert.equal(venda.status, 'erro');
    assert.equal(venda.fila, null);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM vendas WHERE fila = 'pronta'").get() as { n: number }).n,
      0,
    );

    const retry = await request('/api/retry', {
      method: 'POST',
      token,
      body: JSON.stringify({ id_venda: venda.id_venda }),
    }, port);
    assert.equal(retry.status, 400);
    assert.match(retry.body, /painel.*fila/i);
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

test('falha EACCES ao procurar XML registra a Venda como a_verificar sem 502', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-painel-eacces-'));
  const outputDir = join(root, 'output');
  const dbPath = join(root, 'emissor.db');
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  await mkdir(outputDir);
  await writeFile(join(outputDir, 'autorizacao'), 'não é uma pasta');
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir,
    emitirNfse: async () => ({}),
    buscarChaveNoXmlPorNdps: () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({
        ...EMISSAO_TESTE,
        vServ: 100,
        tomador: TOMADOR_TESTE,
      }),
    }, port);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { autorizada: false, chaveAcesso: null });

    const db = initDb(dbPath);
    const venda = db.prepare('SELECT status, fila, erro FROM vendas').get() as {
      status: string;
      fila: string | null;
      erro: string | null;
    } | undefined;
    assert.equal(venda?.status, 'a_verificar');
    assert.equal(venda?.fila, null);
    assert.match(venda?.erro ?? '', /conciliação manual/i);
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

test('retry de rejeição coloca status e fila prontos para nova reserva', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-painel-retry-'));
  const dbPath = join(root, 'emissor.db');
  const app = createPainelApp({ panelPort: 0, dbPath });
  const database = initDb(dbPath);
  upsertVenda({ id_venda: 'venda-retry-painel', fonte: 'lastlink', produto: 'produto', fila: 'pronta', status: 'pronta' });
  assert.ok(reservarEmissao('venda-retry-painel', root));
  marcarTentativaRejeitada('venda-retry-painel', 'Falha antes do envio.');
  const { server: httpServer, port } = await listen(app);

  try {
    const token = await pageToken(port);
    const response = await request('/api/retry', {
      method: 'POST',
      token,
      body: JSON.stringify({ id_venda: 'venda-retry-painel' }),
    }, port);
    assert.equal(response.status, 200);
    const venda = database.prepare('SELECT status, fila FROM vendas WHERE id_venda = ?')
      .get('venda-retry-painel') as { status: string; fila: string };
    assert.equal(venda.status, 'pronta');
    assert.equal(venda.fila, 'pronta');
    assert.ok(reservarEmissao('venda-retry-painel', root));
  } finally {
    await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

test('retry de erro legado sem tentativa exige conferir e conciliar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-painel-retry-legado-'));
  const dbPath = join(root, 'emissor.db');
  const app = createPainelApp({ panelPort: 0, dbPath });
  initDb(dbPath);
  upsertVenda({ id_venda: 'venda-erro-legada-painel', fonte: 'lastlink', produto: 'produto', fila: 'pronta', status: 'pronta' });
  marcarStatus('venda-erro-legada-painel', 'erro', 'timeout legado');
  const { server: httpServer, port } = await listen(app);

  try {
    const token = await pageToken(port);
    const response = await request('/api/retry', {
      method: 'POST',
      token,
      body: JSON.stringify({ id_venda: 'venda-erro-legada-painel' }),
    }, port);
    assert.equal(response.status, 409);
    assert.match(response.body, /SEFIN|concil/i);
  } finally {
    await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

test('falha antes da reserva não marca tentativa de nenhuma Venda', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-painel-sem-reserva-'));
  const dbPath = join(root, 'emissor.db');
  const outputDir = join(root, 'output');
  await mkdir(outputDir);
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  let marcas = 0;
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    ambiente: 1,
    agora: new Date('2026-12-01T03:00:00Z'),
    outputDir,
    criarEReservarEmissao: () => { throw new Error('falha antes da reserva'); },
    marcarTentativaAveriguar: () => { marcas++; },
    marcarTentativaRejeitada: () => { marcas++; },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({ ...EMISSAO_TESTE, tomador: TOMADOR_TESTE, vServ: 100 }),
    }, port);
    assert.equal(response.status, 502);
    assert.equal(marcas, 0);
    const database = initDb(dbPath);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM tentativas_emissao').get() as { n: number }).n, 0);
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});

test('falha ao gravar transição responde 500 e deixa a Venda para conferência', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nfse-painel-transicao-'));
  const dbPath = join(root, 'emissor.db');
  const outputDir = join(root, 'output');
  await mkdir(outputDir);
  const antigoModo = process.env['EMITIR_REAL'];
  process.env['EMITIR_REAL'] = '1';
  const app = createPainelApp({
    panelPort: 0,
    dbPath,
    outputDir,
    emitirNfse: async () => ({}),
    marcarTentativaAveriguar: () => { throw new Error('banco indisponível'); },
  });
  let httpServer: Server | undefined;

  try {
    const listening = await listen(app);
    httpServer = listening.server;
    const { port } = listening;
    const token = await pageToken(port);
    const response = await request('/api/emitir', {
      method: 'POST',
      token,
      body: JSON.stringify({ ...EMISSAO_TESTE, tomador: TOMADOR_TESTE, vServ: 100 }),
    }, port);
    assert.equal(response.status, 500);
    assert.match(response.body, /ficou para conferência/i);
    const database = initDb(dbPath);
    assert.equal(
      (database.prepare("SELECT status FROM vendas WHERE fonte = 'painel'").get() as { status: string }).status,
      'emitindo',
    );
  } finally {
    if (antigoModo === undefined) delete process.env['EMITIR_REAL'];
    else process.env['EMITIR_REAL'] = antigoModo;
    if (httpServer) await close(httpServer);
    initDb(':memory:');
    await rm(root, { recursive: true, force: true });
  }
});
