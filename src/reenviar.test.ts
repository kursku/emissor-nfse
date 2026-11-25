import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { initDb, registrarNota, upsertVenda } from './store.js';
import { reenviarNota } from './reenviar.js';

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
  return { xmlPath, pdfPath };
}

test('dry-run mostra destinatario mascarado e caminhos sem chamar o sender', async () => {
  const { xmlPath, pdfPath } = prepararBanco({ email: 'cliente.teste@example.invalid', xml: true });
  const linhas: string[] = [];
  let chamadas = 0;

  await reenviarNota('venda-sintetica', false, {
    log: (linha) => linhas.push(linha),
    enviarEmailNota: async () => { chamadas++; },
  });

  const saida = linhas.join('\n');
  assert.match(saida, /c\*\*\*@example\.invalid/);
  assert.doesNotMatch(saida, /cliente\.teste@example\.invalid/);
  assert.match(saida, new RegExp(chave));
  assert.match(saida, new RegExp(`${xmlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*encontrado`));
  assert.match(saida, new RegExp(`${pdfPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*ausente`));
  assert.equal(existsSync(xmlPath), true);
  assert.equal(chamadas, 0);
});

test('--enviar chama o sender uma vez com e-mail salvo e chave da Nota', async () => {
  prepararBanco({ email: 'cliente.teste@example.invalid' });
  const chamadas: Array<[string | undefined, string]> = [];

  await reenviarNota('venda-sintetica', true, {
    enviarEmailNota: async (venda, notaChave) => {
      chamadas.push([venda.email, notaChave]);
    },
  });

  assert.deepEqual(chamadas, [['cliente.teste@example.invalid', chave]]);
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
