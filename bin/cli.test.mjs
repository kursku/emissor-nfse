import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

test('CLI lista reenviar e roteia o comando sem argumento para o script', () => {
  const ajuda = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(ajuda.status, 0);
  assert.match(ajuda.stdout, /nfse reenviar <id_venda> \[--enviar\]/);

  const resultado = spawnSync(process.execPath, [cli, 'reenviar'], { encoding: 'utf8' });
  assert.equal(resultado.status, 1);
  assert.match(resultado.stderr, /Uso: nfse reenviar <id_venda> \[--enviar\]/);
});
