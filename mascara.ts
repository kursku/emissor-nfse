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
