/**
 * Envio de e-mail pós-emissão com DANFSe anexo.
 * O DANFSe tenta o ADN e cai para a geração local quando necessário.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Venda } from './store.js';
import { obterDanfse } from './danfse.js';
import type { ObterDanfseDeps } from './danfse.js';
import { erroEnvioEmail, montarHtmlNota } from './email-validacao.js';

export interface EnviarEmailNotaDeps {
  obterDanfse?: typeof obterDanfse;
  fetch?: typeof fetch;
  outputDir?: string;
  ambiente?: 1 | 2;
  browser?: string;
}

export async function enviarEmailNota(
  venda: Venda,
  chave: string,
  deps: EnviarEmailNotaDeps = {},
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_NOTAS ?? process.env.RESEND_FROM;
  const erro = erroEnvioEmail({ email: venda.email, apiKey, from });
  if (erro) throw new Error(erro);

  const precisaConfig = deps.outputDir === undefined || deps.ambiente === undefined || deps.browser === undefined;
  const configuracao = precisaConfig ? (await import('./config.js')).config : undefined;
  const outputDir = deps.outputDir ?? configuracao!.outputDir;
  const ambiente = deps.ambiente ?? configuracao!.ambiente;
  const browser = deps.browser ?? (configuracao?.danfseBrowser || undefined);
  const obter = deps.obterDanfse ?? obterDanfse;
  let danfse: Awaited<ReturnType<typeof obterDanfse>> = null;
  try {
    danfse = await obter(chave, {
      outputDir,
      ambiente,
      browser,
    } satisfies ObterDanfseDeps);
  } catch {
    console.warn('  DANFSe indisponivel (falha na leitura e geração local), enviando sem anexo');
  }

  const pdf = danfse && 'pdf' in danfse ? danfse.pdf : null;
  if (pdf) {
    try {
      writeFileSync(join(outputDir, `danfse-${chave}.pdf`), pdf);
    } catch {
      console.warn('  DANFSe: PDF não salvo; anexo mantido');
    }
  } else if (danfse && 'html' in danfse) {
    console.warn('  DANFSe só em HTML, enviando sem anexo');
  }

  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: venda.email,
      subject: `Nota fiscal emitida — ${venda.produto ?? 'serviço'}`,
      html: montarHtmlNota(venda.nome, chave, Boolean(pdf)),
      ...(pdf
        ? {
            attachments: [
              { filename: `danfse-${chave}.pdf`, content: pdf.toString('base64') },
            ],
          }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
