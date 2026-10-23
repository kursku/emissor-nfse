import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('falha de certificado na fila deixa Venda retryable, não a verificar', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'nfse-fila-pre-envio-'));
  const script = `
    const { initDb, listVendas, upsertVenda } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    db.prepare('INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)')
      .run('produto-teste', '080201', '122051900', 'Servico');
    upsertVenda({
      id_venda: 'venda-certificado', fonte: 'lastlink', produto: 'produto-teste', valor: 100,
      cpf_cnpj: '11444777000161', nome: 'Tomador', cep: '13000000', cidade: 'Campinas', uf: 'SP',
      cmun: '3509502', rua: 'Rua', numero: '1', bairro: 'Centro', fila: 'pronta', status: 'pronta'
    });
    const venda = listVendas({ id_venda: 'venda-certificado' })[0];
    const resultado = await processarVenda(venda, db, 1, () => true);
    console.log(JSON.stringify({ resultado, venda: listVendas({ id_venda: 'venda-certificado' })[0] }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      EMITIR_REAL: '1',
      NFSE_CNPJ: '11444777000161',
      NFSE_COD_MUNICIPIO: '3509502',
      NFSE_CERT_PATH: join(outputDir, 'inexistente.p12'),
      NFSE_CERT_PASSWORD: 'teste',
      NFSE_IM: '1',
      NFSE_UF: 'SP',
      NFSE_AMBIENTE: '2',
      NFSE_OUTPUT_DIR: outputDir,
    },
  });
  rmSync(outputDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const linha = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(linha);
  const saida = JSON.parse(linha) as {
    resultado: { resultado: string };
    venda: { status: string; fila: string | null };
  };
  assert.equal(saida.resultado.resultado, 'erro');
  assert.equal(saida.venda.status, 'erro');
  assert.equal(saida.venda.fila, null);
});

test('Contrato incompleto vira excecao retryable antes da reserva', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'nfse-fila-contrato-incompleto-'));
  const script = `
    const { initDb, criarContrato, gerarVendasDoMes, listVendas, marcarStatus, recolocarVendaNaFila } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    const id = criarContrato({
      cliente_doc: '11444777000161', cliente_nome: 'Contrato legado',
      cliente_cmun: '3509502', cliente_cep: '13000000', cliente_rua: 'Rua',
      cliente_numero: '1', cliente_bairro: 'Centro', valor: 100,
      xdesc_serv: 'Servico', ctrib_nac: '080201', cnbs: '122051900', dia_do_mes: 1,
    });
    gerarVendasDoMes('2026-03');
    db.prepare('UPDATE contratos SET cnbs = NULL WHERE id = ?').run(id);
    const venda = listVendas({ id_venda: 'contrato-1-2026-03' })[0];
    const resultado = await processarVenda(venda, db, 1, () => { throw new Error('não deveria reservar'); });
    marcarStatus(venda.id_venda, resultado.resultado, resultado.msg);
    const final = listVendas({ id_venda: venda.id_venda })[0];
    console.log(JSON.stringify({ resultado, final, retry: recolocarVendaNaFila(venda.id_venda) }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      EMITIR_REAL: '1',
      NFSE_CNPJ: '11444777000161',
      NFSE_COD_MUNICIPIO: '3509502',
      NFSE_CERT_PATH: join(outputDir, 'inexistente.p12'),
      NFSE_CERT_PASSWORD: 'teste',
      NFSE_IM: '1',
      NFSE_UF: 'SP',
      NFSE_AMBIENTE: '2',
      NFSE_OUTPUT_DIR: outputDir,
    },
  });
  rmSync(outputDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const linha = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(linha);
  const saida = JSON.parse(linha) as {
    resultado: { resultado: string; msg: string };
    final: { status: string; fila: string | null; erro: string | null };
    retry: { ok: boolean };
  };
  assert.equal(saida.resultado.resultado, 'excecao');
  assert.match(saida.resultado.msg, /Contrato 1 sem mapeamento fiscal/);
  assert.equal(saida.final.status, 'excecao');
  assert.equal(saida.final.fila, 'excecao');
  assert.match(saida.final.erro ?? '', /Contrato 1 sem mapeamento fiscal/);
  assert.deepEqual(saida.retry, { ok: true });
});

test('Contrato com cNBS mas sem endereço vira excecao retryable antes da reserva', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'nfse-fila-contrato-endereco-'));
  const script = `
    const { initDb, criarContrato, gerarVendasDoMes, listVendas, marcarStatus, recolocarVendaNaFila } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    const id = criarContrato({
      cliente_doc: '11444777000161', cliente_nome: 'Contrato sem endereço',
      cliente_cmun: '3509502', cliente_cep: '13000000', cliente_rua: 'Rua',
      cliente_numero: '1', cliente_bairro: 'Centro', valor: 100,
      xdesc_serv: 'Servico', ctrib_nac: '080201', cnbs: '122051900', dia_do_mes: 1,
    });
    gerarVendasDoMes('2026-03');
    const idVenda = 'contrato-' + id + '-2026-03';
    db.prepare('UPDATE vendas SET cmun = NULL, cep = NULL, rua = NULL, numero = NULL, bairro = NULL WHERE id_venda = ?').run(idVenda);
    const venda = listVendas({ id_venda: idVenda })[0];
    const resultado = await processarVenda(venda, db, 1, () => { throw new Error('não deveria reservar'); });
    marcarStatus(venda.id_venda, resultado.resultado, resultado.msg);
    const final = listVendas({ id_venda: venda.id_venda })[0];
    console.log(JSON.stringify({ resultado, final, retry: recolocarVendaNaFila(venda.id_venda) }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      EMITIR_REAL: '1',
      NFSE_CNPJ: '11444777000161',
      NFSE_COD_MUNICIPIO: '3509502',
      NFSE_CERT_PATH: join(outputDir, 'inexistente.p12'),
      NFSE_CERT_PASSWORD: 'teste',
      NFSE_IM: '1',
      NFSE_UF: 'SP',
      NFSE_AMBIENTE: '2',
      NFSE_OUTPUT_DIR: outputDir,
    },
  });
  rmSync(outputDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const linha = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(linha);
  const saida = JSON.parse(linha) as {
    resultado: { resultado: string; msg: string };
    final: { status: string; fila: string | null; erro: string | null };
    retry: { ok: boolean };
  };
  assert.equal(saida.resultado.resultado, 'excecao');
  assert.match(saida.resultado.msg, /endereço|tomador\.end|cMun|logradouro/i);
  assert.equal(saida.final.status, 'excecao');
  assert.equal(saida.final.fila, 'excecao');
  assert.deepEqual(saida.retry, { ok: true });
});

test('erro pré-reserva volta após corrigir o mapa fiscal e permite emitir', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'nfse-fila-retry-mapa-'));
  const script = `
    const { initDb, listVendas, upsertVenda, marcarStatus, recolocarVendaNaFila, buscarNotaPorVenda } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    upsertVenda({
      id_venda: 'venda-mapa-corrigido', fonte: 'lastlink', produto: 'produto-novo', valor: 100,
      cpf_cnpj: '11444777000161', nome: 'Tomador', cep: '13000000', cidade: 'Campinas', uf: 'SP',
      cmun: '3509502', rua: 'Rua', numero: '1', bairro: 'Centro', fila: 'pronta', status: 'pronta'
    });
    const venda = listVendas({ id_venda: 'venda-mapa-corrigido' })[0];
    const primeiro = await processarVenda(venda, db, 1, () => true);
    marcarStatus(venda.id_venda, primeiro.resultado, primeiro.msg);
    db.prepare('INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)')
      .run('produto-novo', '080201', '122051900', 'Servico');
    const retry = recolocarVendaNaFila(venda.id_venda);
    const vendaRetry = listVendas({ id_venda: venda.id_venda })[0];
    const segundo = await processarVenda(vendaRetry, db, 1, () => true,
      async () => ({ chNFSe: '1'.repeat(50) }));
    console.log(JSON.stringify({ primeiro, retry, segundo, final: listVendas({ id_venda: venda.id_venda })[0], nota: Boolean(buscarNotaPorVenda(venda.id_venda)) }));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      EMITIR_REAL: '1',
      NFSE_CNPJ: '11444777000161',
      NFSE_COD_MUNICIPIO: '3509502',
      NFSE_CERT_PATH: join(outputDir, 'inexistente.p12'),
      NFSE_CERT_PASSWORD: 'teste',
      NFSE_IM: '1',
      NFSE_UF: 'SP',
      NFSE_AMBIENTE: '2',
      NFSE_OUTPUT_DIR: outputDir,
    },
  });
  rmSync(outputDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const linha = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(linha);
  const saida = JSON.parse(linha) as {
    primeiro: { resultado: string };
    retry: { ok: boolean };
    segundo: { resultado: string };
    final: { status: string; fila: string | null };
    nota: boolean;
  };
  assert.equal(saida.primeiro.resultado, 'excecao');
  assert.deepEqual(saida.retry, { ok: true });
  assert.equal(saida.segundo.resultado, 'emitida');
  assert.equal(saida.final.status, 'emitida');
  assert.equal(saida.final.fila, 'pronta');
  assert.equal(saida.nota, true);
});
