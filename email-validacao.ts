/**
 * Validação dos pré-requisitos de enviarEmailNota, extraída para um módulo
 * sem import de config.ts — email.ts importa config.ts (via http-mtls.ts),
 * que exige NFSE_* no ambiente e derruba o processo se ausente (ex.: CI).
 */
export interface DadosEnvioEmail {
  email?: string;
  apiKey?: string;
  from?: string;
}

/** Retorna a mensagem de erro do primeiro pré-requisito ausente, ou null se ok. */
export function erroEnvioEmail({ email, apiKey, from }: DadosEnvioEmail): string | null {
  if (!email) return 'venda sem e-mail';
  if (!apiKey) return 'RESEND_API_KEY ausente';
  if (!from) return 'RESEND_FROM_NOTAS/RESEND_FROM ausente';
  return null;
}
