import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'nfse-http-mtls-test-'));
const certPath = join(root, 'synthetic-cert.p12');
await writeFile(certPath, 'synthetic test certificate placeholder');
const savedEnv = Object.fromEntries(
  ['NFSE_CNPJ', 'NFSE_IM', 'NFSE_UF', 'NFSE_COD_MUNICIPIO', 'NFSE_CERT_PATH', 'NFSE_CERT_PASSWORD']
    .map((name) => [name, process.env[name]]),
);
Object.assign(process.env, {
  NFSE_CNPJ: '12345678000195',
  NFSE_IM: '12345',
  NFSE_UF: 'SP',
  NFSE_COD_MUNICIPIO: '3550308',
  NFSE_CERT_PATH: certPath,
  NFSE_CERT_PASSWORD: 'synthetic-only',
});

const { getComCertificado } = await import('./http-mtls.js');

test.after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function withServer(handler: http.RequestListener, action: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await action(`https://127.0.0.1:${address.port}/`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withHttpRequest<T>(action: () => Promise<T>): Promise<T> {
  const originalGet = https.get;
  https.get = ((url: string | URL, options: object, callback: (res: http.IncomingMessage) => void) => {
    return http.get(String(url).replace('https://', 'http://'), options as http.ClientRequestArgs, callback);
  }) as typeof https.get;
  try {
    return await action();
  } finally {
    https.get = originalGet;
  }
}

test('corpo interrompido rejeita sem aguardar o total timeout', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-length': 1000 });
    res.write('%PDF-abc');
    setTimeout(() => req.socket.destroy(), 20).unref();
  }, async (url) => {
    await withHttpRequest(async () => {
      await assert.rejects(
        () => getComCertificado(url, { timeoutMs: 1000, totalTimeoutMs: 2000 }),
        /resposta interrompida|socket hang up|aborted/i,
      );
    });
  });
});

test('conta-gotas termina antes do timeout total quando o corpo fecha', async () => {
  await withServer((_req, res) => {
    res.writeHead(200);
    let n = 0;
    const timer = setInterval(() => {
      res.write(String(n++));
      if (n === 3) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
  }, async (url) => {
    await withHttpRequest(async () => {
      const resposta = await getComCertificado(url, { timeoutMs: 1000, totalTimeoutMs: 2000 });
      assert.equal(resposta.status, 200);
      assert.equal(resposta.buf.toString(), '012');
    });
  });
});

test('conta-gotas travado respeita o prazo total', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': 1000 });
    res.write('%PDF-abc');
    const timer = setInterval(() => res.write('x'), 20);
    setTimeout(() => clearInterval(timer), 500).unref();
  }, async (url) => {
    await withHttpRequest(async () => {
      const inicio = Date.now();
      await assert.rejects(
        () => getComCertificado(url, { timeoutMs: 1000, totalTimeoutMs: 100 }),
        /timeout total de 100ms/,
      );
      assert.ok(Date.now() - inicio < 1000);
    });
  });
});
