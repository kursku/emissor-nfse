/**
 * Validação dos pré-requisitos de enviarEmailNota, extraída para um módulo
 * sem import de config.ts, para validar o contrato sem carregar credenciais.
 */
export interface DadosEnvioEmail {
  email?: string;
  apiKey?: string;
  from?: string;
}

const LOCAL_EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_EMAIL_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function emailEstrito(email: string): boolean {
  if (email.length > 254) return false;
  const separador = email.lastIndexOf('@');
  if (separador <= 0) return false;
  const local = email.slice(0, separador);
  const dominio = email.slice(separador + 1);
  return local.length <= 64 && LOCAL_EMAIL_RE.test(local) && DOMAIN_EMAIL_RE.test(dominio);
}

export function escaparHtml(valor: string | null | undefined): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(valor ?? '').replace(/[&<>"']/g, (caractere) => escapes[caractere] ?? caractere);
}

export function montarHtmlNota(nome: string | null | undefined, chave: string, temAnexo: boolean): string {
  return (
    `<p>Olá, ${escaparHtml(nome)}!</p>` +
    '<p>Sua nota fiscal de serviço foi emitida.</p>' +
    `<p>Chave de acesso: <code>${escaparHtml(chave)}</code></p>` +
    (temAnexo ? '<p>O DANFSe está em anexo.</p>' : '')
  );
}

/** Retorna a mensagem de erro do primeiro pré-requisito ausente, ou null se ok. */
export function erroEnvioEmail({ email, apiKey, from }: DadosEnvioEmail): string | null {
  if (!email) return 'venda sem e-mail';
  if (!emailEstrito(email)) return 'venda com e-mail inválido';
  if (!apiKey) return 'RESEND_API_KEY ausente';
  if (!from) return 'RESEND_FROM_NOTAS/RESEND_FROM ausente';
  return null;
}
