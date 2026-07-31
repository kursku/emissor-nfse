/**
 * Testes do parse de endereco. Todos os enderecos aqui sao inventados.
 *
 * Endereco errado nao e so um campo torto: a SEFIN recusa a nota inteira com
 * E0234, e endereco *incompleto* seria pior que ausente — por isso o parse
 * devolve null em vez de adivinhar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEnderecoLastlink } from './endereco-lastlink.js';

test('formato padrao do export', () => {
  const e = parseEnderecoLastlink('Rua Exemplo 123, Centro, 01001000, Cidade Exemplo - SP');
  assert.deepEqual(e, {
    xLgr: 'Rua Exemplo',
    nro: '123',
    xBairro: 'Centro',
    CEP: '01001000',
    cidade: 'Cidade Exemplo',
    uf: 'SP',
  });
});

test('CEP com hifen e normalizado para 8 digitos', () => {
  const e = parseEnderecoLastlink('Avenida Brasil 45, Jardim Novo, 01001-000, Cidade Exemplo - SP');
  assert.equal(e?.CEP, '01001000');
});

test('logradouro com virgula extra nao desloca bairro, CEP e cidade', () => {
  const e = parseEnderecoLastlink(
    'Rua das Flores, 10, apto 22, Vila Nova, 01310000, Sao Paulo - SP',
  );
  assert.equal(e?.xBairro, 'Vila Nova');
  assert.equal(e?.CEP, '01310000');
  assert.equal(e?.cidade, 'Sao Paulo');
  assert.equal(e?.uf, 'SP');
});

test('numero com letra e preservado', () => {
  const e = parseEnderecoLastlink('Rua Alfa 12B, Centro, 01001000, Cidade Exemplo - SP');
  assert.equal(e?.nro, '12B');
  assert.equal(e?.xLgr, 'Rua Alfa');
});

test('logradouro sem numero vira S/N', () => {
  const e = parseEnderecoLastlink('Estrada Velha, Zona Rural, 01001000, Cidade Exemplo - SP');
  assert.equal(e?.nro, 'S/N');
  assert.equal(e?.xLgr, 'Estrada Velha');
});

test('cidade com nome composto e UF em minuscula', () => {
  const e = parseEnderecoLastlink('Rua B 9, Centro, 15000000, Sao Jose do Rio Preto - sp');
  assert.equal(e?.cidade, 'Sao Jose do Rio Preto');
  assert.equal(e?.uf, 'SP');
});

test('recusa em vez de adivinhar: partes de menos', () => {
  assert.equal(parseEnderecoLastlink('Rua Exemplo 123, Centro'), null);
  assert.equal(parseEnderecoLastlink(''), null);
  assert.equal(parseEnderecoLastlink(null), null);
  assert.equal(parseEnderecoLastlink(undefined), null);
});

test('recusa CEP invalido', () => {
  assert.equal(parseEnderecoLastlink('Rua Exemplo 123, Centro, 1340, Cidade Exemplo - SP'), null);
});

test('recusa quando falta a UF no fim', () => {
  assert.equal(parseEnderecoLastlink('Rua Exemplo 123, Centro, 01001000, Cidade Exemplo'), null);
});
