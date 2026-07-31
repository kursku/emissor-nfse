/**
 * http-mtls.ts — GET autenticado pelo certificado do prestador (mTLS).
 *
 * A SEFIN e o ADN identificam o emitente pelo proprio certificado A1 usado na
 * assinatura, entao toda consulta a esses servicos e um GET com o `.p12`
 * apresentado no handshake.
 *
 * Contrato unico de erro: falha de rede, DNS ou timeout **lanca**; resposta
 * HTTP recebida **retorna**, com o status para o chamador decidir. Antes cada
 * chamador inventava o seu (um rejeitava, dois escondiam a falha num campo de
 * texto), e a divergencia escondia erro de rede como se fosse resposta.
 */
import https from 'node:https';
import { readFileSync } from 'node:fs';

import { config, exigirCertificado } from './config.js';

export interface RespostaMtls {
  status: number;
  contentType: string;
  buf: Buffer;
  /** Corpo como texto — conveniencia para respostas JSON da parametrizacao. */
  texto(): string;
}

/**
 * @param url endereco completo
 * @param opcoes.agentePadrao `true` para nao herdar o globalAgent do emissor,
 *   cuja cadeia de CAs so cobre a SEFIN (o ADN usa CA publica).
 */
export function getComCertificado(
  url: string,
  opcoes: { timeoutMs?: number; agentePadrao?: boolean } = {},
): Promise<RespostaMtls> {
  exigirCertificado();
  const { timeoutMs = 30000, agentePadrao = true } = opcoes;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ...(agentePadrao ? { agent: false } : {}),
        pfx: readFileSync(config.certPath),
        passphrase: config.certPassword,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            contentType: (res.headers['content-type'] as string) ?? '',
            buf,
            texto: () => buf.toString('utf-8'),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout de ${timeoutMs}ms em ${url}`));
    });
    req.on('error', reject);
  });
}
