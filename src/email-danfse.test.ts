import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { enviarEmailNota } from './email.js';

const chave = '9'.repeat(50);
const pdf = Buffer.from('%PDF-email\n%%EOF');

test('falha ao gravar mantém PDF do DANFSe no anexo', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-email-danfse-'));
  const pdfPath = join(outputDir, `danfse-${chave}.pdf`);
  await mkdir(pdfPath);
  const apiKeyAnterior = process.env.RESEND_API_KEY;
  const fromAnterior = process.env.RESEND_FROM;
  process.env.RESEND_API_KEY = 'test-only-key';
  process.env.RESEND_FROM = 'sender@example.invalid';
  let body: Record<string, unknown> | undefined;
  try {
    await enviarEmailNota(
      { id_venda: 'venda-sintetica', email: 'cliente@example.invalid', nome: 'Cliente Sintetico' },
      chave,
      {
        outputDir,
        ambiente: 2,
        browser: '',
        obterDanfse: async () => ({ pdf, origem: 'local' }),
        fetch: (async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return { ok: true, status: 200, text: async () => '' } as Response;
        }) as typeof fetch,
      },
    );
    const anexos = body?.attachments as Array<{ filename: string; content: string }>;
    assert.equal(anexos.length, 1);
    assert.equal(anexos[0].filename, `danfse-${chave}.pdf`);
    assert.deepEqual(Buffer.from(anexos[0].content, 'base64'), pdf);
  } finally {
    if (apiKeyAnterior === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = apiKeyAnterior;
    if (fromAnterior === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = fromAnterior;
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('HTML local envia sem anexo', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-email-html-'));
  try {
    const anterior = process.env.RESEND_API_KEY;
    const fromAnterior = process.env.RESEND_FROM;
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.RESEND_FROM = 'sender@example.invalid';
    let body: Record<string, unknown> | undefined;
    const warnings: string[] = [];
    const warnAnterior = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      await enviarEmailNota(
        { id_venda: 'venda-sintetica', email: 'cliente@example.invalid', nome: 'Cliente Sintetico' },
        chave,
        {
          outputDir,
          ambiente: 2,
          browser: '',
          obterDanfse: async () => ({ html: '<html>danfse</html>' }),
          fetch: (async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return { ok: true, status: 200, text: async () => '' } as Response;
          }) as typeof fetch,
        },
      );
    } finally {
      console.warn = warnAnterior;
      if (anterior === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = anterior;
      if (fromAnterior === undefined) delete process.env.RESEND_FROM;
      else process.env.RESEND_FROM = fromAnterior;
    }
    assert.equal('attachments' in (body ?? {}), false);
    assert.match(warnings.join('\n'), /DANFSe só em HTML/);
    assert.doesNotMatch(warnings.join('\n'), /browser ausente/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('falha ao obter DANFSe ainda envia sem anexo', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nfse-email-error-'));
  try {
    const anterior = process.env.RESEND_API_KEY;
    const fromAnterior = process.env.RESEND_FROM;
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.RESEND_FROM = 'sender@example.invalid';
    let body: Record<string, unknown> | undefined;
    try {
      await enviarEmailNota(
        { id_venda: 'venda-sintetica', email: 'cliente@example.invalid', nome: 'Cliente Sintetico' },
        chave,
        {
          outputDir,
          ambiente: 2,
          browser: '',
          obterDanfse: async () => { throw new Error('falha sintética'); },
          fetch: (async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return { ok: true, status: 200, text: async () => '' } as Response;
          }) as typeof fetch,
        },
      );
    } finally {
      if (anterior === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = anterior;
      if (fromAnterior === undefined) delete process.env.RESEND_FROM;
      else process.env.RESEND_FROM = fromAnterior;
    }
    assert.equal('attachments' in (body ?? {}), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
