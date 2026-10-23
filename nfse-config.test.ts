import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { criarNfseConfig } from './nfse-config.js';

test('desliga os transports da lib sem expor a senha no ValidateEnvironment', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'nfse-25-logger-'));
  const password = 'senha-teste-25-NAO-LOGAR';

  try {
    const config = criarNfseConfig({
      cnpj: '11222333000181',
      uf: 'SP',
      ambiente: 2,
      certPath: 'teste.p12',
      certPassword: password,
      outputDir: logDir,
    });

    assert.deepEqual(config.lib?.log, {
      exibirLogNoConsole: false,
      armazenarLogs: false,
    });

    const loggerConfig = JSON.stringify({ ...config.lib?.log, pathLogs: logDir });
    const loggingModule = new URL('./nfewizard-logging.ts', import.meta.url).href;
    const script = `
      const { silenciarLogsNfseWizard } = await import(${JSON.stringify(loggingModule)});
      silenciarLogsNfseWizard();
      import { logger, ValidateEnvironment } from '@nfewizard/shared';
      logger.initialize(${loggerConfig});
      new ValidateEnvironment().checkRequiredSettings({
        dfe: { pathCertificado: 'teste.p12', senhaCertificado: ${JSON.stringify(password)} },
        nfe: { ambiente: 2 },
      });
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(password));
    assert.deepEqual(await readdir(logDir), []);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test('emissor silencia a lib antes de construir o NFSe', () => {
  const source = readFileSync(new URL('./emissor.ts', import.meta.url), 'utf8');
  const silenciamento = source.indexOf('silenciarLogsNfseWizard();');
  const construcao = source.indexOf('new NFSe(nfseConfig)');

  assert.ok(silenciamento >= 0);
  assert.ok(construcao > silenciamento);
});
