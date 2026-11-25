import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { initDb, registrarNota, upsertVenda } from './store.js';
import { reenviarNota } from './reenviar.js';
import { parseArgs } from './reenviar.js';

const raizTeste = mkdtempSync(join(tmpdir(), 'nfse-reenviar-test-'));
const chave = '9'.repeat(50);
let sequencia = 0;

function prepararBanco(opcoes: { email?: string; nota?: boolean; xml?: boolean; venda?: boolean } = {}) {
  const pasta = join(raizTeste, String(++sequencia));
  mkdirSync(pasta);
  const xmlPath = join(pasta, 'nfse.xml');
  const pdfPath = join(pasta, 'danfse.pdf');
  if (opcoes.xml) writeFileSync(xmlPath, '<NFSe sintetica/>');

  initDb(join(pasta, 'emissor.db'));
  if (opcoes.venda !== false) {
    upsertVenda({
      id_venda: 'venda-sintetica',
      fonte: 'teste',
      nome: 'Cliente Sintetico',
      ...(opcoes.email !== undefined ? { email: opcoes.email } : {}),
    });
  }
  if (opcoes.venda !== false && opcoes.nota !== false) {
    registrarNota({
      id_venda: 'venda-sintetica',
      chave_acesso: chave,
      ndps: 12,
      xml_path: xmlPath,
      pdf_path: pdfPath,
    });
  }
  return { xmlPath, pdfPath, outputDir: pasta };
}

test('dry-run mostra destinatario mascarado e caminhos sem chamar o sender', async () => {
  const { xmlPath, pdfPath, outputDir } = prepararBanco({ email: 'cliente.teste@example.invalid', xml: true });
  const xmlLocal = join(outputDir, 'autorizacao', `${chave}.xml`);
  mkdirSync(join(outputDir, 'autorizacao'));
  writeFileSync(xmlLocal, '<NFSe sintetica/>');
  const linhas: string[] = [];
  let chamadas = 0;

  await reenviarNota('venda-sintetica', false, {
    outputDir,
    log: (linha) => linhas.push(linha),
    enviarEmailNota: async () => { chamadas++; },
  });

  const saida = linhas.join('\n');
  assert.match(saida, /c\*\*\*@example\.invalid/);
  assert.doesNotMatch(saida, /cliente\.teste@example\.invalid/);
  assert.match(saida, new RegExp(chave));
  assert.match(saida, /ADN será tentado primeiro \(não consultado na simulação\)/);
  assert.match(saida, new RegExp(`${xmlLocal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*encontrado`));
  assert.doesNotMatch(saida, /XML da Nota:|DANFSe PDF:/);
  assert.doesNotMatch(saida, new RegExp(xmlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(saida, new RegExp(pdfPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(existsSync(xmlPath), true);
  assert.equal(chamadas, 0);
});

test('dry-run informa quando o XML local da autorização está ausente', async () => {
  const { outputDir } = prepararBanco({ email: 'cliente@example.invalid' });
  const linhas: string[] = [];
  await reenviarNota('venda-sintetica', false, { outputDir, log: (linha) => linhas.push(linha) });
  assert.match(linhas.join('\n'), /autorizacao.*\.xml.*ausente/);
  assert.match(linhas.join('\n'), /ADN será tentado primeiro \(não consultado na simulação\)/);
});

test('--enviar chama o sender uma vez com e-mail salvo e chave da Nota', async () => {
  prepararBanco({ email: 'cliente.teste@example.invalid' });
  const chamadas: Array<[string | undefined, string]> = [];

  await reenviarNota('venda-sintetica', true, {
    enviarEmailNota: async (venda, notaChave, opcoes) => {
      chamadas.push([venda.email, notaChave]);
      assert.equal(opcoes?.exigirDanfse, true);
    },
  });

  assert.deepEqual(chamadas, [['cliente.teste@example.invalid', chave]]);
});

test('mascara enderecos de e-mail validos com caracteres variados', async () => {
  for (const [email, mascara] of [
    ["o'neil@x.co", "o***@x.co"],
    ['a+b@sub.dom.com', 'a***@sub.dom.com'],
    ['a@b.c', 'a***@b.c'],
  ]) {
    const { outputDir } = prepararBanco({ email });
    const linhas: string[] = [];
    await reenviarNota('venda-sintetica', false, { outputDir, log: (linha) => linhas.push(linha) });
    assert.match(linhas.join('\n'), new RegExp(mascara.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(linhas.join('\n'), new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('parseArgs só aceita --enviar como o segundo e único argumento opcional', () => {
  for (const args of [
    ['--enviar'],
    ['X', '--envia'],
    ['--enviar', 'X'],
    ['X', '--enviar', '--enviar'],
    ['X', '--real'],
  ]) {
    assert.throws(() => parseArgs(args), /Uso: nfse reenviar/);
  }
  assert.deepEqual(parseArgs(['X', '--enviar']), { idVenda: 'X', enviar: true });
  assert.deepEqual(parseArgs(['X']), { idVenda: 'X', enviar: false });
});

test('recusa venda inexistente, sem Nota e sem e-mail válido antes do sender', async () => {
  const casos = [
    { mensagem: /Venda venda-sintetica não encontrada/, preparar: () => prepararBanco({ venda: false }) },
    { mensagem: /não possui Nota emitida/, preparar: () => prepararBanco({ email: 'cliente@example.invalid', nota: false }) },
    { mensagem: /venda sem e-mail/, preparar: () => prepararBanco() },
    { mensagem: /e-mail inválido/, preparar: () => prepararBanco({ email: 'endereco-invalido' }) },
  ];

  let chamadas = 0;
  for (const caso of casos) {
    caso.preparar();
    await assert.rejects(
      reenviarNota('venda-sintetica', true, {
        enviarEmailNota: async () => { chamadas++; },
      }),
      caso.mensagem,
    );
  }
  assert.equal(chamadas, 0);
});

test.after(() => {
  initDb(':memory:');
  rmSync(raizTeste, { recursive: true, force: true });
});
