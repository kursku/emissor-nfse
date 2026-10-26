import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { arquivarNota } from './arquivar-nota.js';

const chave = '9'.repeat(50);
const pdf = Buffer.from('%PDF-archive\n%%EOF');

async function prepararArquivo(): Promise<{ root: string; archived: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nfse-arquivar-test-'));
  const source = join(root, 'source');
  const dbPath = join(root, 'state.db');
  await mkdir(join(source, 'autorizacao'), { recursive: true });
  await writeFile(join(source, 'autorizacao', `${chave}.xml`), '<NFSe />');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE vendas (id_venda TEXT, data_venda TEXT); CREATE TABLE notas (chave_acesso TEXT, ndps INTEGER, id_venda TEXT);');
  db.prepare('INSERT INTO vendas VALUES (?, ?)').run('venda-sintetica', '2026-10-26');
  db.prepare('INSERT INTO notas VALUES (?, ?, ?)').run(chave, 42, 'venda-sintetica');
  db.close();
  return { root, archived: join(root, 'output', 'notas', '2026-10', 'venda-sintetica') };
}

test('arquivar salva HTML quando o browser não está disponível', async () => {
  const { root, archived } = await prepararArquivo();
  const source = join(root, 'source');
  const dbPath = join(root, 'state.db');
  try {
    await arquivarNota('venda-sintetica', {
      baseDir: root,
      dbPath,
      outputDir: source,
      ambiente: 2,
      obterDanfse: async () => ({ html: '<html>danfse sintetico</html>' }),
    });

    assert.equal(existsSync(join(archived, 'nfse.xml')), true);
    assert.equal(await readFile(join(archived, 'danfse.html'), 'utf8'), '<html>danfse sintetico</html>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('arquivar salva PDF quando o ADN ou browser retorna PDF', async () => {
  const { root, archived } = await prepararArquivo();
  try {
    await arquivarNota('venda-sintetica', {
      baseDir: root,
      dbPath: join(root, 'state.db'),
      outputDir: join(root, 'source'),
      ambiente: 2,
      obterDanfse: async () => ({ pdf, origem: 'adn' }),
    });
    assert.deepEqual(await readFile(join(archived, 'danfse.pdf')), pdf);
    assert.equal(existsSync(join(archived, 'danfse.html')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('arquivar avisa quando o DANFSe é indisponível', async () => {
  const { root, archived } = await prepararArquivo();
  try {
    await arquivarNota('venda-sintetica', {
      baseDir: root,
      dbPath: join(root, 'state.db'),
      outputDir: join(root, 'source'),
      ambiente: 2,
      obterDanfse: async () => null,
    });
    assert.equal(existsSync(join(archived, 'danfse.pdf')), false);
    assert.equal(existsSync(join(archived, 'danfse.html')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
