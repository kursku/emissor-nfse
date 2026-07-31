/**
 * Testes do seam: a DPS montada. Rodam sem certificado, sem .env e sem rede.
 *
 * Os valores esperados sao literais conhecidos-bons (retirados do layout e de
 * DPS aceitas pela SEFIN), nunca recalculados do mesmo jeito que o codigo os
 * calcula — teste que recalcula passa por construcao e nao prova nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { montarDps, momentoSP } from './montar-dps.js';
import type { ConfigPrestador, EmissaoInput } from './montar-dps.js';

const CFG: ConfigPrestador = {
  cnpj: '11222333000181',
  im: '654321',
  codMunicipio: '3509502',
  ambiente: 2,
  regTrib: { opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 },
  pTotTribSN: 6.0,
};

const INPUT: EmissaoInput = {
  nDPS: '7',
  tomador: { CNPJ: '11444777000161', xNome: 'EMPRESA EXEMPLO LTDA' },
  xDescServ: 'Servico de exemplo.',
  vServ: 1234.56,
  cTribNac: '080201',
  cNBS: '122051900',
  cIndOp: '100301',
  cClassTrib: '000001',
};

// 12:00Z = 09:00 em Sao Paulo (UTC-3), mesmo dia — nao cruza a virada do dia.
const AGORA = new Date('2026-01-31T12:00:00Z');

test('prestador e local de emissao vem da configuracao, nao do input', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.equal(infDps.prest.CNPJ, '11222333000181');
  assert.equal(infDps.prest.IM, '654321');
  assert.equal(infDps.cLocEmi, '3509502');
  assert.equal(infDps.serv.locPrest.cLocPrestacao, '3509502');
  assert.equal(infDps.tpAmb, 2);
});

test('competencia e data de emissao no fuso de Sao Paulo', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.equal(infDps.dCompet, '2026-01-31');
  assert.equal(infDps.dhEmi, '2026-01-31T09:00:00-03:00');
});

test('21:00 em Sao Paulo no dia 31 nao vira competencia de fevereiro', () => {
  // 2026-02-01T00:00Z ainda e 2026-01-31T21:00 em Sao Paulo.
  assert.equal(momentoSP(new Date('2026-02-01T00:00:00Z')).dCompet, '2026-01-31');
});

test('tomador com CNPJ usa CNPJ e nunca CPF', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.equal(infDps.toma.CNPJ, '11444777000161');
  assert.ok(!('CPF' in infDps.toma));
});

test('tomador com CPF usa CPF e nunca CNPJ', () => {
  const input: EmissaoInput = {
    ...INPUT,
    tomador: { CPF: '52998224725', xNome: 'PESSOA EXEMPLO' },
  };
  const { infDps } = montarDps(input, CFG, AGORA);
  assert.equal(infDps.toma.CPF, '52998224725');
  assert.ok(!('CNPJ' in infDps.toma));
});

test('endereco do tomador e omitido quando nao informado (XSD minOccurs=0)', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.ok(!('end' in infDps.toma));
});

test('endereco completo entra aninhado em endNac', () => {
  const input: EmissaoInput = {
    ...INPUT,
    tomador: {
      ...INPUT.tomador,
      end: {
        cMun: '3509502',
        CEP: '13000000',
        xLgr: 'Rua Exemplo',
        nro: '100',
        xBairro: 'Centro',
      },
    },
  };
  const { infDps } = montarDps(input, CFG, AGORA);
  assert.equal(infDps.toma.end.endNac.cMun, '3509502');
  assert.equal(infDps.toma.end.endNac.CEP, '13000000');
  assert.equal(infDps.toma.end.xBairro, 'Centro');
  assert.ok(!('xCpl' in infDps.toma.end)); // complemento ausente nao vira campo vazio
});

test('ME/EPP declara regApTribSN — a SEFIN exige (E0166)', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.equal(infDps.prest.regTrib.opSimpNac, 3);
  assert.equal(infDps.prest.regTrib.regApTribSN, 1);
});

test('nao optante pelo Simples omite regApTribSN', () => {
  const cfg: ConfigPrestador = { ...CFG, regTrib: { ...CFG.regTrib, opSimpNac: 1 } };
  const { infDps } = montarDps(INPUT, cfg, AGORA);
  assert.equal(infDps.prest.regTrib.opSimpNac, 1);
  assert.ok(!('regApTribSN' in infDps.prest.regTrib));
});

test('MEI omite regApTribSN', () => {
  const cfg: ConfigPrestador = { ...CFG, regTrib: { ...CFG.regTrib, opSimpNac: 2 } };
  const { infDps } = montarDps(INPUT, cfg, AGORA);
  assert.ok(!('regApTribSN' in infDps.prest.regTrib));
});

test('pTotTribSN cai para o valor da configuracao quando o input nao traz', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.equal(infDps.valores.trib.totTrib.pTotTribSN, 6.0);
});

test('pTotTribSN do input vence a configuracao (servico de outro anexo)', () => {
  const { infDps } = montarDps({ ...INPUT, pTotTribSN: 15.5 }, CFG, AGORA);
  assert.equal(infDps.valores.trib.totTrib.pTotTribSN, 15.5);
});

test('valor, codigos do servico e nDPS chegam intactos', () => {
  const { infDps } = montarDps(INPUT, CFG, AGORA);
  assert.equal(infDps.nDPS, '7');
  assert.equal(infDps.serie, '00001');
  assert.equal(infDps.valores.vServPrest.vServ, 1234.56);
  assert.equal(infDps.serv.cServ.cTribNac, '080201');
  assert.equal(infDps.serv.cServ.cNBS, '122051900');
  assert.equal(infDps.IBSCBS.cIndOp, '100301');
  assert.equal(infDps.IBSCBS.valores.trib.gIBSCBS.cClassTrib, '000001');
});
