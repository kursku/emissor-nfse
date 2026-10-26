import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { NFE_SchemaValidate } from '@nfewizard/shared';

import {
  DanfseBrowserUnavailableError,
  caminhoNoPath,
  encontrarBrowser,
  gerarDanfseHtml,
  gerarDanfsePdf,
  obterDanfse,
} from './danfse.js';

const xml = await readFile(new URL('./fixtures/danfse-sintetica.xml', import.meta.url), 'utf8');
const chave = '9'.repeat(50);
const pdfLocal = Buffer.from('%PDF-local\n%%EOF');

function variantes() {
  return {
    base: xml,
    tomadorPJ: xml,
    semTomador: xml.replace(/\s*<toma>[\s\S]*?<\/toma>/, ''),
  };
}

async function withOutput(action: (outputDir: string) => Promise<void>): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-danfse-test-'));
  try {
    await action(outputDir);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

test('HTML valida chave, nNFSe, IBSCBS, tomador PJ e sem tomador', async () => {
  const html = await gerarDanfseHtml(xml);
  assert.match(html, new RegExp(chave));
  assert.match(html, /Prestador Sintetico/);
  assert.match(html, /Tomador Sintetico/);
  assert.match(html, /Valor Total Apurado/);
  assert.match(await gerarDanfseHtml(variantes().semTomador), /TOMADOR\/ADQUIRENTE/);
});

test('fixture e variantes passam no schema NFSe v1.01', async () => {
  for (const [nome, variante] of Object.entries(variantes())) {
    const result = await NFE_SchemaValidate(variante, 'NFSe_Consulta', {
      validator: 'validateSchemaJsBased',
    });
    assert.equal(result.success, true, `${nome}: ${result.message}`);
    assert.equal(result.schema, 'NFSe_v1.01.xsd');
  }
});

test('XML inválido não vira DANFSe em branco', async () => {
  await assert.rejects(() => gerarDanfseHtml(''));
  await assert.rejects(() => gerarDanfseHtml(xml.replace('<nNFSe>42</nNFSe>', '<nNFSe>-</nNFSe>')));
});

test('ADN sem PDF cai para geração local', async () => {
  await withOutput(async (outputDir) => {
    await mkdir(join(outputDir, 'autorizacao'));
    await writeFile(join(outputDir, 'autorizacao', `${chave}.xml`), xml);
    const logs: string[] = [];
    const result = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      baixarAdn: async () => Buffer.from('<html>ADN indisponivel</html>'),
      gerarPdf: async (value) => {
        assert.equal(value, xml);
        return pdfLocal;
      },
      logger: { log: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) },
    });
    assert.deepEqual(result, { pdf: pdfLocal, origem: 'local' });
    assert.deepEqual(logs, ['  DANFSe: gerado localmente a partir do XML original; eventos posteriores não são refletidos']);
  });
});

test('ADN com PDF válido não chama a geração local', async () => {
  let localTentado = false;
  const result = await obterDanfse(chave, {
    outputDir: 'não-usado',
    ambiente: 2,
    baixarAdn: async () => pdfLocal,
    gerarPdf: async () => {
      localTentado = true;
      return pdfLocal;
    },
    logger: { log: () => {}, warn: () => {} },
  });
  assert.deepEqual(result, { pdf: pdfLocal, origem: 'adn' });
  assert.equal(localTentado, false);
});

test('ADN e geração local falham e registram ambas as tentativas', async () => {
  await withOutput(async (outputDir) => {
    await mkdir(join(outputDir, 'autorizacao'));
    await writeFile(join(outputDir, 'autorizacao', `${chave}.xml`), xml);
    let localTentado = false;
    const logs: string[] = [];
    const result = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      baixarAdn: async () => Buffer.from('{}'),
      gerarPdf: async () => {
        localTentado = true;
        throw new Error('falha local');
      },
      logger: { log: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) },
    });
    assert.ok(result && 'html' in result);
    assert.equal(localTentado, true);
    assert.match(logs[0], /ADN sem PDF/);
    assert.match(logs[0], /browser falhou/);
  });
});

test('XML ausente ou chave divergente não chama o browser', async () => {
  await withOutput(async (outputDir) => {
    let localTentado = false;
    const result = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      baixarAdn: async () => Buffer.from('not-pdf'),
      gerarPdf: async () => {
        localTentado = true;
        return pdfLocal;
      },
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal(result, null);
    assert.equal(localTentado, false);

    await mkdir(join(outputDir, 'autorizacao'));
    await writeFile(
      join(outputDir, 'autorizacao', `${chave}.xml`),
      xml.replace(`NFS${chave}`, `NFS${'8'.repeat(50)}`),
    );
    const divergente = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      baixarAdn: async () => Buffer.from('not-pdf'),
      gerarPdf: async () => {
        localTentado = true;
        return pdfLocal;
      },
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal(divergente, null);
    assert.equal(localTentado, false);
  });
});

test('sem browser retorna HTML local para arquivar', async () => {
  await withOutput(async (outputDir) => {
    await mkdir(join(outputDir, 'autorizacao'));
    await writeFile(join(outputDir, 'autorizacao', `${chave}.xml`), xml);
    const result = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      browser: join(outputDir, 'browser-inexistente.exe'),
      baixarAdn: async () => Buffer.from('not-pdf'),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.ok(result && 'html' in result);
    assert.match(result.html, /Prestador Sintetico/);
  });
});

test('falha de PDF local com XML válido preserva HTML', async () => {
  await withOutput(async (outputDir) => {
    await mkdir(join(outputDir, 'autorizacao'));
    await writeFile(join(outputDir, 'autorizacao', `${chave}.xml`), xml);
    const result = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      baixarAdn: async () => Buffer.from('not-pdf'),
      gerarPdf: async () => { throw new Error('browser falhou'); },
      logger: { log: () => {}, warn: () => {} },
    });
    assert.ok(result && 'html' in result);
  });
});

test('PDF local truncado não é aceito e vira HTML', async () => {
  await withOutput(async (outputDir) => {
    await mkdir(join(outputDir, 'autorizacao'));
    await writeFile(join(outputDir, 'autorizacao', `${chave}.xml`), xml);
    const result = await obterDanfse(chave, {
      outputDir,
      ambiente: 2,
      baixarAdn: async () => Buffer.from('not-pdf'),
      gerarPdf: async () => Buffer.from('%PDF-truncado'),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.ok(result && 'html' in result);
  });
});

test('chave pública inválida é rejeitada antes de qualquer consulta ou caminho', async () => {
  let adnChamado = false;
  await assert.rejects(
    () => obterDanfse('curta', {
      outputDir: 'não-deve-ser-usado',
      ambiente: 2,
      baixarAdn: async () => { adnChamado = true; return pdfLocal; },
    }),
    /chave de acesso inválida/,
  );
  assert.equal(adnChamado, false);
});

test('descoberta controlada ignora diretório e não executável e respeita ordem do PATH', async () => {
  if (process.platform === 'win32') return;
  const primeiro = await mkdtemp(join(tmpdir(), 'nfse-browser-path-1-'));
  const segundo = await mkdtemp(join(tmpdir(), 'nfse-browser-path-2-'));
  const anterior = process.env.PATH;
  try {
    await mkdir(join(primeiro, 'browser-teste'));
    const semExecucao = join(primeiro, 'browser-teste');
    await writeFile(semExecucao, '#!/bin/sh\nexit 0');
    await chmod(semExecucao, 0o644);
    const executavel = join(segundo, 'browser-teste');
    await writeFile(executavel, '#!/bin/sh\nexit 0');
    await chmod(executavel, 0o755);
    process.env.PATH = `${primeiro}${delimiter}${segundo}`;
    assert.equal(encontrarBrowser('browser-teste'), executavel);
  } finally {
    if (anterior === undefined) delete process.env.PATH;
    else process.env.PATH = anterior;
    await rm(primeiro, { recursive: true, force: true });
    await rm(segundo, { recursive: true, force: true });
  }
});

test('descoberta aceita symlink executável e ignora symlink quebrado', async () => {
  if (process.platform === 'win32') return;
  const pasta = await mkdtemp(join(tmpdir(), 'nfse-browser-symlink-'));
  const anterior = process.env.PATH;
  try {
    const alvo = join(pasta, 'browser-real');
    const link = join(pasta, 'browser-link');
    const linkQuebrado = join(pasta, 'browser-quebrado');
    await writeFile(alvo, '#!/bin/sh\nexit 0');
    await chmod(alvo, 0o755);
    await symlink(alvo, link);
    await symlink(join(pasta, 'nao-existe'), linkQuebrado);
    process.env.PATH = pasta;
    assert.equal(encontrarBrowser('browser-link'), link);
    assert.equal(caminhoNoPath('browser-quebrado'), undefined);
  } finally {
    if (anterior === undefined) delete process.env.PATH;
    else process.env.PATH = anterior;
    await rm(pasta, { recursive: true, force: true });
  }
});

function browserDisponivel(): string | undefined {
  try {
    return encontrarBrowser(process.env.NFSE_DANFSE_BROWSER);
  } catch {
    return undefined;
  }
}

const browserDeIntegracao = browserDisponivel();
test('integração gera PDF real com browser headless', { skip: !browserDeIntegracao }, async () => {
  const pdf = await gerarDanfsePdf(xml, { browser: browserDeIntegracao });
  assert.ok(pdf.length > 0);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  console.log(`[evidência DANFSe] PDF ${pdf.length} bytes; primeiros bytes ${pdf.subarray(0, 4).toString()}`);
});

test('erro de browser configurado é classificável sem expor caminho', async () => {
  await assert.rejects(
    () => gerarDanfsePdf(xml, { browser: 'browser-inexistente' }),
    (err: unknown) => err instanceof DanfseBrowserUnavailableError,
  );
});
