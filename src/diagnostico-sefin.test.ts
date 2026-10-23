import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extrairDiagnosticoSefin,
  textoDiagnosticoSefin,
  textoErroSefin,
} from './diagnostico-sefin.js';
import { initDb, listVendas, marcarStatus, upsertVenda } from './store.js';

test('mantém o diagnóstico SEFIN e mascara/corta o complemento', () => {
  const complemento = [
    'CPF 111.444.777-35',
    'CNPJ 11.444.777/0001-61',
    ' '.repeat(20),
    'detalhe '.repeat(45),
    'MARCADOR_FORA_DO_LIMITE',
  ].join(' ');
  const diagnostico = extrairDiagnosticoSefin({
    nfseErrorDetail: {
      codigo: 'E1235',
      descricao: 'DPS rejeitada pela SEFIN',
      complemento,
      statusHttp: 422,
      idDps: 'DPS350950221122233300018100001000000000042',
    },
    response: {
      data: {
        nome: 'Nome do tomador que não deve ir para o log',
        endereco: 'Rua que não deve ir para o log',
        email: 'tomador@example.test',
      },
    },
  }, { nDPS: '42' });

  assert.ok(diagnostico);
  const texto = textoDiagnosticoSefin(diagnostico);

  assert.match(texto, /codigo=E1235/);
  assert.match(texto, /descricao=DPS rejeitada pela SEFIN/);
  assert.match(texto, /nDPS=42/);
  assert.match(texto, /idDPS=DPS350950221122233300018100001000000000042/);
  assert.match(texto, /complemento=/);
  assert.doesNotMatch(texto, /111\.444\.777-35|11\.444\.777\/0001-61/);
  assert.doesNotMatch(texto, /MARCADOR_FORA_DO_LIMITE/);
  assert.doesNotMatch(texto, /Nome do tomador|Rua que não deve|tomador@example\.test/);

  const complementoLog = texto.match(/complemento=([^;]*)/)?.[1] ?? '';
  assert.ok(complementoLog.length <= 300);
});

test('extrai somente campos SEFIN permitidos do corpo da resposta', () => {
  const diagnostico = extrairDiagnosticoSefin({
    response: {
      data: {
        codigo: 'E0116',
        descricao: 'Inscrição Municipal inválida',
        nome: 'Pessoa que não deve ser registrada',
        email: 'privado@example.test',
      },
    },
  }, { nDPS: '43' });

  assert.ok(diagnostico);
  const texto = textoDiagnosticoSefin(diagnostico);
  assert.match(texto, /codigo=E0116/);
  assert.match(texto, /descricao=Inscrição Municipal inválida/);
  assert.match(texto, /nDPS=43/);
  assert.doesNotMatch(texto, /Pessoa que não deve|privado@example\.test/);
});

test('erro HTTP sem resumo não leva corpo pessoal para Venda nem console', () => {
  initDb(':memory:');
  upsertVenda({
    id_venda: 'venda-diagnostico-seguro',
    fonte: 'lastlink',
    produto: 'produto-teste',
    valor: 100,
    fila: 'pronta',
    status: 'pronta',
  });
  const corpo = { nome: 'Fulano', endereco: 'Rua X', email: 'a@b.com' };
  const erro = Object.assign(new Error(`HTTP 400: ${JSON.stringify(corpo)}`), {
    nfseErrorDetail: { raw: corpo },
  });
  const mensagem = textoErroSefin(erro, { nDPS: '7' });
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    marcarStatus('venda-diagnostico-seguro', 'erro', mensagem);
    console.error(mensagem);
  } finally {
    console.error = originalError;
  }

  const venda = listVendas({ id_venda: 'venda-diagnostico-seguro' })[0];
  assert.match(mensagem, /nDPS=7/);
  assert.match(mensagem, /HTTP 400/);
  assert.doesNotMatch(mensagem, /Fulano|Rua X|a@b\.com/);
  assert.doesNotMatch(venda?.erro ?? '', /Fulano|Rua X|a@b\.com/);
  assert.doesNotMatch(logs.join('\n'), /Fulano|Rua X|a@b\.com/);
});

test('mascara documentos antes de truncar o complemento', () => {
  const cpf = extrairDiagnosticoSefin({
    nfseErrorDetail: { complemento: `${'x'.repeat(290)} CPF 111.444.777-35` },
  });
  const cnpj = extrairDiagnosticoSefin({
    nfseErrorDetail: { complemento: `${'x'.repeat(285)} CNPJ 11.444.777/0001-61` },
  });

  assert.ok(cpf?.complemento);
  assert.ok(cnpj?.complemento);
  assert.doesNotMatch(cpf.complemento, /111\.4/);
  assert.doesNotMatch(cnpj.complemento, /11\.444\.77/);
  assert.match(cnpj.complemento, /114\.\.\.61/);
});

test('valida e limita campos escalares do diagnóstico SEFIN', () => {
  const descricao = `Falha para a@b.com ${'x'.repeat(250)}`;
  const idDPS = 'D'.repeat(80);
  const diagnostico = extrairDiagnosticoSefin({
    nfseErrorDetail: {
      codigo: 'E12345',
      descricao,
      idDPS,
    },
  }, { codigos: ['X999', 'A123'] });

  assert.ok(diagnostico);
  assert.equal(diagnostico.codigo, 'A123');
  assert.equal(diagnostico.descricao?.length, 200);
  assert.match(diagnostico.descricao ?? '', /a\*\*\*@b\.com/);
  assert.equal(diagnostico.idDPS?.length, 60);
  const texto = textoDiagnosticoSefin(diagnostico);
  assert.doesNotMatch(texto, /a@b\.com/);
});

test('resume no máximo cinco itens allowlisted do raw', () => {
  const diagnostico = extrairDiagnosticoSefin({
    nfseErrorDetail: {
      raw: {
        erros: [
          { Codigo: 'E1000', Descricao: 'Erro zero' },
          { codigo: 'E1001', descricao: 'Erro um' },
          { codigo: 'E1002', descricao: 'Erro dois' },
        ],
        alertas: [
          { codigo: 'A1000', descricao: 'Aviso para a@b.com' },
          { codigo: 'A1001', descricao: 'Aviso um' },
          { codigo: 'A1002', descricao: 'Aviso fora do limite' },
        ],
      },
    },
  });

  assert.ok(diagnostico);
  const texto = textoDiagnosticoSefin(diagnostico);
  assert.match(texto, /E1000|E1001|E1002/);
  assert.match(texto, /A1000|A1001/);
  assert.doesNotMatch(texto, /A1002|Aviso fora do limite/);
  assert.match(texto, /a\*\*\*@b\.com/);
  assert.doesNotMatch(texto, /a@b\.com/);
});

test('preserva mensagem local mascarada e limitada quando não há diagnóstico SEFIN', () => {
  const mensagem = textoErroSefin(new Error(
    `Emissão inválida: CPF 111.444.777-35; ${'detalhe '.repeat(80)}`,
  ));

  assert.match(mensagem, /Emissão inválida/);
  assert.match(mensagem, /CPF 111\.\.\.35/);
  assert.doesNotMatch(mensagem, /111\.444\.777-35/);
  assert.ok(mensagem.length <= 300);
});
