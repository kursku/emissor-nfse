/**
 * Testes das validacoes de borda. Documentos usados sao exemplos publicos de
 * teste, nao pertencem a ninguem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cepInvalido,
  cNBSInvalido,
  cnpjInvalido,
  codMunicipioInvalido,
  cpfInvalido,
  cTribNacInvalido,
  docTomadorInvalido,
  vServInvalido,
} from './validacoes.mjs';

test('CNPJ valido passa, com ou sem pontuacao', () => {
  assert.equal(cnpjInvalido('11222333000181'), null);
  assert.equal(cnpjInvalido('11.222.333/0001-81'), null);
});

test('CNPJ com digito verificador errado e recusado', () => {
  assert.match(cnpjInvalido('11222333000182'), /digito verificador/);
});

test('CNPJ com digitos repetidos e recusado antes do calculo', () => {
  assert.match(cnpjInvalido('00000000000000'), /repetidos/);
});

test('CNPJ com tamanho errado e recusado', () => {
  assert.match(cnpjInvalido('1122233300018'), /14 digitos/);
  assert.match(cnpjInvalido(''), /14 digitos/);
});

test('CPF valido passa; digito errado e recusado', () => {
  assert.equal(cpfInvalido('52998224725'), null);
  assert.match(cpfInvalido('52998224726'), /digito verificador/);
  assert.match(cpfInvalido('11111111111'), /repetidos/);
});

test('tomador aceita CPF ou CNPJ, nunca os dois', () => {
  assert.equal(docTomadorInvalido({ CNPJ: '11222333000181' }), null);
  assert.equal(docTomadorInvalido({ CPF: '52998224725' }), null);
  assert.match(
    docTomadorInvalido({ CPF: '52998224725', CNPJ: '11222333000181' }),
    /ao mesmo tempo/,
  );
  assert.match(docTomadorInvalido({}), /precisa de CPF ou CNPJ/);
});

test('cTribNac exige 6 digitos', () => {
  assert.equal(cTribNacInvalido('080201'), null);
  assert.match(cTribNacInvalido('8.02.01'), /6 digitos/);
  assert.match(cTribNacInvalido('80201'), /6 digitos/);
});

test('cNBS exige 9 digitos', () => {
  assert.equal(cNBSInvalido('122051900'), null);
  assert.match(cNBSInvalido('1.2205.19.00'), /9 digitos/);
});

test('codigo de municipio exige 7 digitos e CEP exige 8', () => {
  assert.equal(codMunicipioInvalido('3509502'), null);
  assert.match(codMunicipioInvalido('350950'), /7 digitos/);
  assert.equal(cepInvalido('13000-000'), null);
  assert.match(cepInvalido('1300000'), /8 digitos/);
});

test('vServ precisa ser numero maior que zero', () => {
  assert.equal(vServInvalido(0.01), null);
  assert.match(vServInvalido(0), /maior que zero/);
  assert.match(vServInvalido(-10), /maior que zero/);
  assert.match(vServInvalido('100'), /numero/);
  assert.match(vServInvalido(NaN), /numero/);
});
