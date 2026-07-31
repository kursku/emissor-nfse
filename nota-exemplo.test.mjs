/**
 * O modelo que a operadora copia tem que passar no proprio validador.
 *
 * Existe porque falhou de verdade: `nota-exemplo.json` foi escrito com
 * CNPJ 00000000000000 antes de a validacao por digito verificador entrar, e
 * ninguem reexecutou o exemplo contra ela. Os testes de `validacoes.mjs`
 * passavam — eles cobrem as funcoes, nao o arquivo entregue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cepInvalido,
  cNBSInvalido,
  cTribNacInvalido,
  codMunicipioInvalido,
  docTomadorInvalido,
  vServInvalido,
} from './validacoes.mjs';

const nota = JSON.parse(
  readFileSync(join(import.meta.dirname, 'nota-exemplo.json'), 'utf-8'),
);

test('nota-exemplo.json tem todos os campos obrigatorios', () => {
  for (const campo of ['idVenda', 'tomador', 'xDescServ', 'vServ', 'cTribNac', 'cNBS']) {
    assert.ok(nota[campo] !== undefined && nota[campo] !== null, `falta o campo ${campo}`);
  }
});

test('nota-exemplo.json passa em todas as validacoes de emitir-avulsa', () => {
  const problemas = [
    docTomadorInvalido(nota.tomador),
    cTribNacInvalido(nota.cTribNac),
    cNBSInvalido(nota.cNBS),
    vServInvalido(nota.vServ),
    nota.tomador.end ? cepInvalido(nota.tomador.end.CEP) : null,
    nota.tomador.end ? codMunicipioInvalido(nota.tomador.end.cMun) : null,
  ].filter(Boolean);
  assert.deepEqual(problemas, [], `o exemplo shipado seria recusado: ${problemas.join(' | ')}`);
});
