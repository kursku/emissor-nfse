/**
 * Testes da geracao do XML da DPS. Sem rede e sem certificado.
 *
 * O XSD e validado pela lib; aqui o alvo e a montagem do envelope — Id, versao,
 * namespace e a presenca dos campos que a SEFIN rejeita quando faltam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gerarXmlDps, validarXsd } from './dps-xml.js';
import type { ConfigPrestador, EmissaoInput } from './montar-dps.js';
import { docTomadorInvalido } from './validacoes.mjs';

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

const AGORA = new Date('2026-01-31T12:00:00Z');

test('o envelope tem declaracao UTF-8, versao e namespace do SPED', () => {
  const xml = gerarXmlDps(INPUT, CFG, AGORA);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<DPS versao="1\.01" xmlns="http:\/\/www\.sped\.fazenda\.gov\.br\/nfse">/);
});

test('Id segue o padrao DPS + 42 digitos exigido pelo XSD', () => {
  const xml = gerarXmlDps(INPUT, CFG, AGORA);
  const id = /<infDPS Id="([^"]+)"/.exec(xml)?.[1];
  assert.ok(id, 'atributo Id ausente');
  assert.match(id, /^DPS\d{42}$/);
  assert.ok(id.startsWith('DPS3509502211222333000181'), 'Id deve seguir o layout nacional');
});

test('nDPS diferente produz Id diferente', () => {
  const a = /<infDPS Id="([^"]+)"/.exec(gerarXmlDps(INPUT, CFG, AGORA))?.[1];
  const b = /<infDPS Id="([^"]+)"/.exec(
    gerarXmlDps({ ...INPUT, nDPS: '8' }, CFG, AGORA),
  )?.[1];
  assert.notEqual(a, b);
});

test('os campos que a SEFIN recusa quando faltam estao no XML', () => {
  const xml = gerarXmlDps(INPUT, CFG, AGORA);
  assert.match(xml, /<IM>654321<\/IM>/); // E0116
  assert.match(xml, /<regApTribSN>1<\/regApTribSN>/); // E0166
  assert.match(xml, /<pTotTribSN>6<\/pTotTribSN>/); // E0712
  assert.match(xml, /<dCompet>2026-01-31<\/dCompet>/);
  assert.match(xml, /<vServ>1234\.56<\/vServ>/);
});

test('finNFSe fica em infDPS antes de cLocEmi', async () => {
  const xml = gerarXmlDps(INPUT, CFG, AGORA);
  assert.match(xml, /<tpEmit>1<\/tpEmit><finNFSe>0<\/finNFSe><cLocEmi>3509502<\/cLocEmi>/);
  assert.doesNotMatch(xml, /<IBSCBS><finNFSe>0<\/finNFSe>/);

  const semFinNFSe = xml.replace('<finNFSe>0</finNFSe>', '');
  const semFinResult = await validarXsd(semFinNFSe);
  assert.equal(semFinResult.ok, false, 'o XSD novo deve exigir finNFSe em infDPS');
});

test('XML montado passa na validacao XSD', async () => {
  const { ok, msg } = await validarXsd(gerarXmlDps(INPUT, CFG, AGORA));
  assert.equal(ok, true, msg);
});

test('Série inválida não é aceita pelo contorno do falso positivo do schema', async () => {
  const xml = gerarXmlDps(INPUT, CFG, AGORA).replace('<serie>00001</serie>', '<serie>abc</serie>');
  const { ok, msg } = await validarXsd(xml);
  assert.equal(ok, false);
  assert.match(msg, /Série inválida|serie/i);
});

test('erro de schema junto do falso positivo de Série continua inválido', async () => {
  const xml = gerarXmlDps({ ...INPUT, cNBS: '123' }, CFG, AGORA);
  const { ok, msg } = await validarXsd(xml);
  assert.equal(ok, false);
  assert.match(msg, /cNBS/);
});

test('documento ausente continua inválido e a validação de borda também o exige', async () => {
  const semDoc = { ...INPUT, tomador: { xNome: 'SEM DOCUMENTO' } } as EmissaoInput;
  const { ok, msg } = await validarXsd(gerarXmlDps(semDoc, CFG, AGORA));
  assert.equal(ok, false);
  assert.match(msg, /CNPJ|CPF|documento|toma/i);
  assert.match(docTomadorInvalido({}), /precisa de CPF ou CNPJ/);
});
