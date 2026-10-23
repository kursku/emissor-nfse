import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { comandoConciliacao } from './emitir-avulsa-helpers.js';
import { exigirEmissaoValida, exigirIdentificadorSeguro } from './validar-emissao.js';
import type { EmissaoInput } from './montar-dps.js';

const INPUT: EmissaoInput = {
  nDPS: '7',
  tomador: {
    CNPJ: '11444777000161',
    xNome: 'EMPRESA EXEMPLO LTDA',
    end: {
      cMun: '3509502',
      CEP: '13000000',
      xLgr: 'Rua Exemplo',
      nro: '100',
      xBairro: 'Centro',
    },
  },
  xDescServ: 'Servico de exemplo.',
  vServ: 100,
  cTribNac: '080201',
  cNBS: '122051900',
  cIndOp: '100301',
  cClassTrib: '000001',
};

test('validador de emissão confere o dígito do documento do Tomador', () => {
  assert.doesNotThrow(() => exigirEmissaoValida(INPUT));
  assert.throws(
    () => exigirEmissaoValida({ ...INPUT, tomador: { CNPJ: '11444777000162', xNome: 'Tomador' } }),
    /digito verificador/,
  );
  assert.throws(
    () => exigirEmissaoValida({ ...INPUT, tomador: { CPF: '11111111111', xNome: 'Tomador' } }),
    /repetidos/,
  );
});

test('validador de emissão exige nDPS inteiro positivo e campos obrigatórios', () => {
  assert.throws(() => exigirEmissaoValida({ ...INPUT, nDPS: '0' }), /nDPS/);
  assert.throws(() => exigirEmissaoValida({ ...INPUT, nDPS: '1.5' }), /nDPS/);
  assert.throws(() => exigirEmissaoValida({ ...INPUT, xDescServ: '' }), /xDescServ/);
  assert.throws(() => exigirEmissaoValida({ ...INPUT, cNBS: '123' }), /cNBS/);
});

test('validador exige endereço quando o cIndOp torna o Tomador obrigatório', () => {
  assert.throws(
    () => exigirEmissaoValida({ ...INPUT, tomador: { ...INPUT.tomador, end: undefined } }),
    /tomador\.end.*obrigatório/i,
  );
});

test('validador central recusa CST sem indicador ind_gIBSCBS confirmado', () => {
  assert.throws(
    () => exigirEmissaoValida({ ...INPUT, cClassTrib: '200052' }),
    /cClassTrib 200052: CST 200 sem indicador ind_gIBSCBS confirmado/,
  );
});

test('validador exige CPF, CNPJ e CEP sem pontuação', () => {
  assert.throws(
    () => exigirEmissaoValida({
      ...INPUT,
      tomador: { ...INPUT.tomador, CNPJ: '12.345.678/0001-95' },
    }),
    /CNPJ.*dígitos/i,
  );
  assert.throws(
    () => exigirEmissaoValida({
      ...INPUT,
      tomador: { ...INPUT.tomador, end: { ...INPUT.tomador.end!, CEP: '13000-000' } },
    }),
    /CEP.*dígitos/i,
  );
});

test('validador limita pTotTribSN a número finito entre 0 e 100', () => {
  for (const valor of [-1, 101, NaN]) {
    assert.throws(
      () => exigirEmissaoValida({ ...INPUT, pTotTribSN: valor }),
      /pTotTribSN.*0.*100/i,
    );
  }
  assert.doesNotThrow(() => exigirEmissaoValida({ ...INPUT, pTotTribSN: 0 }));
  assert.doesNotThrow(() => exigirEmissaoValida({ ...INPUT, pTotTribSN: 100 }));
});

test('avulsa deixa as regras fiscais para o validador central', () => {
  const source = readFileSync(new URL('./emitir-avulsa.ts', import.meta.url), 'utf8');
  for (const nome of [
    'docTomadorInvalido',
    'cTribNacInvalido',
    'cNBSInvalido',
    'vServInvalido',
    'cepInvalido',
    'codMunicipioInvalido',
  ]) {
    assert.doesNotMatch(source, new RegExp(nome));
  }
  assert.match(source, /exigirEmissaoValida/);
});

test('instalacao documentada aplica o patch local', () => {
  const cli = readFileSync(new URL('../bin/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /npm ci/);
  assert.match(cli, /npm run patch:apply/);
  assert.doesNotMatch(cli, /Rode "npm install"/);
});

test('setup mostra patch:apply com e sem dependências instaladas', async () => {
  const { comandosInstalacao } = await import('../bin/setup-passos.mjs');
  assert.deepEqual(comandosInstalacao(false), ['npm ci', 'npm run patch:apply']);
  assert.deepEqual(comandosInstalacao(true), ['npm run patch:apply']);
});

test('emissao real valida leiaute e bundle antes do preflight', () => {
  const source = readFileSync(new URL('./emissor.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function emitirNfse');
  const body = source.slice(start);
  const preflight = body.indexOf('conferirDps(input, config)');
  assert.ok(preflight >= 0);
  const layoutGuard = body.indexOf('exigirLeiauteNovoPermitido(config.ambiente)');
  const bundleGuard = body.indexOf('exigirBundlePatchado()');
  assert.ok(layoutGuard >= 0);
  assert.ok(bundleGuard >= 0);
  assert.ok(layoutGuard < preflight);
  assert.ok(bundleGuard < preflight);
});

test('avulsa monta o comando completo de conciliação para os dois resultados', () => {
  assert.equal(comandoConciliacao('venda-1', '9'.repeat(50)), `nfse conciliar venda-1 --chave ${'9'.repeat(50)}`);
  assert.equal(comandoConciliacao('venda-1', undefined, true), 'nfse conciliar venda-1 --rejeitada');
});

test('identificadores rejeitam traversal e separadores antes de formar caminhos', () => {
  assert.doesNotThrow(() => exigirIdentificadorSeguro('cliente-2026-01', 'id da Venda'));
  assert.throws(() => exigirIdentificadorSeguro('../fora', 'id da Venda'), /id da Venda/);
  assert.throws(() => exigirIdentificadorSeguro('cliente\\fora', 'id da Venda'), /id da Venda/);
  assert.throws(() => exigirIdentificadorSeguro('..', 'id da Venda'), /id da Venda/);
  assert.throws(() => exigirEmissaoValida(INPUT, { idVenda: '../fora' }), /id da Venda/);
  assert.throws(() => exigirEmissaoValida(INPUT, { chaveAcesso: 'x'.repeat(50) }), /Chave de acesso/);
});
