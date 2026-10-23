import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adnDanfseUrl,
  ambienteFilho,
  recusaModoReal,
} from './ambiente.mjs';

test('modo sem --real desliga EMITIR_REAL herdado do ambiente', () => {
  assert.deepEqual(ambienteFilho({ EMITIR_REAL: '1', OUTRA: 'preservada' }, false), {
    EMITIR_REAL: '0',
    OUTRA: 'preservada',
  });
});

test('--real em produção restrita é recusado antes da emissão', () => {
  assert.equal(recusaModoReal(true, 2),
    'MODO REAL recusado: NFSE_AMBIENTE=2 é produção restrita e não gera nota fiscal real.');
  assert.equal(recusaModoReal(false, 2), null);
  assert.equal(recusaModoReal(true, 1), null);
});

test('DANFSe usa o host do ADN correspondente ao ambiente', () => {
  assert.equal(adnDanfseUrl(1, 'chave-producao'),
    'https://adn.nfse.gov.br/danfse/chave-producao');
  assert.equal(adnDanfseUrl(2, 'chave-restrita'),
    'https://adn.producaorestrita.nfse.gov.br/danfse/chave-restrita');
});
