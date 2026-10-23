import { logger } from '@nfewizard/shared';

/**
 * A lib avisa pelo stderr quando o Winston fica sem transports e serializa o
 * metadata do evento; substituir os métodos evita que credenciais vazem nesse
 * caminho até a lib oferecer redaction nativa.
 */
export function silenciarLogsNfseWizard(): void {
  // ponytail: no-op nos cinco métodos — o logger da lib não tem hook seguro de redaction.
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  logger.debug = () => {};
  logger.http = () => {};
}
