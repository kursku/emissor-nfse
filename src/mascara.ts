/**
 * Mascara CPF/CNPJ para respostas do painel: 3 primeiros + 2 ultimos digitos.
 * Extraído de server.ts para um módulo sem side effect no import — server.ts
 * sobe o painel (app.listen) e puxa emissor.ts/config.ts, que derrubam o
 * processo sem NFSE_* no ambiente (ex.: CI).
 */
export function mascaraDoc(doc: string | undefined | null): string {
  if (!doc) return '';
  const d = doc.replace(/\D/g, '');
  if (d.length < 5) return d;
  return d.slice(0, 3) + '...' + d.slice(-2);
}

const DOCUMENTO_RE = /(?<!\d)(?:\d{2}[.\/\- ]?\d{3}[.\/\- ]?\d{3}[.\/\- ]?\d{4}[.\/\- ]?\d{2}|\d{3}[.\/\- ]?\d{3}[.\/\- ]?\d{3}[.\/\- ]?\d{2})(?!\d)/g;
const EMAIL_RE = /(?<![A-Za-z0-9._%+\-])([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?![A-Za-z0-9.-])/g;

export function mascararDocumentos(texto: string): string {
  return texto
    .replace(DOCUMENTO_RE, (documento) => mascaraDoc(documento))
    .replace(EMAIL_RE, (_email, local: string, dominio: string) => `${local[0]}***@${dominio}`);
}

export function extrairDocumentosMascarados(texto: string): string[] {
  return [...texto.matchAll(DOCUMENTO_RE)].map(([documento]) => mascaraDoc(documento));
}
