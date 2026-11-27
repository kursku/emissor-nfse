import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { vincularEncerramentoFilho } from './cli.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

function criarFilhoFalso() {
  const sinaisRecebidos = [];
  const filho = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill(sinal) {
      sinaisRecebidos.push(sinal);
      return true;
    },
  });
  return { filho, sinaisRecebidos };
}

test('CLI lista reenviar e roteia o comando sem argumento para o script', () => {
  const ajuda = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(ajuda.status, 0);
  assert.match(ajuda.stdout, /nfse reenviar <id_venda> \[--enviar\]/);

  const resultado = spawnSync(process.execPath, [cli, 'reenviar'], { encoding: 'utf8' });
  assert.equal(resultado.status, 1);
  assert.match(resultado.stderr, /Uso: nfse reenviar <id_venda> \[--enviar\]/);
});

test('vincularEncerramentoFilho repassa SIGTERM e SIGINT ao filho ativo e sai com o codigo do filho', () => {
  const { filho, sinaisRecebidos } = criarFilhoFalso();
  const sinais = new EventEmitter();
  const saidas = [];

  vincularEncerramentoFilho(filho, sinais, (code) => saidas.push(code));

  sinais.emit('SIGTERM', 'SIGTERM');
  sinais.emit('SIGINT', 'SIGINT');
  assert.deepEqual(sinaisRecebidos, ['SIGTERM', 'SIGINT']);

  filho.exitCode = 0;
  filho.emit('exit', 0, null);

  assert.deepEqual(saidas, [0]);
  assert.equal(sinais.listenerCount('SIGTERM'), 0);
  assert.equal(sinais.listenerCount('SIGINT'), 0);
});

test('vincularEncerramentoFilho devolve 143 quando o filho encerra por SIGTERM', () => {
  const { filho } = criarFilhoFalso();
  const sinais = new EventEmitter();
  const saidas = [];

  vincularEncerramentoFilho(filho, sinais, (code) => saidas.push(code));

  filho.signalCode = 'SIGTERM';
  filho.emit('exit', null, 'SIGTERM');

  // POSIX: 128 + SIGTERM (15) = 143.
  assert.deepEqual(saidas, [143]);
});

test('vincularEncerramentoFilho nao tenta matar filho que ja encerrou', () => {
  const { filho, sinaisRecebidos } = criarFilhoFalso();
  filho.exitCode = 0;
  const sinais = new EventEmitter();

  const limpar = vincularEncerramentoFilho(filho, sinais, () => {});
  try {
    sinais.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(sinaisRecebidos, []);
  } finally {
    limpar();
  }
});
