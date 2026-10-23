import type { NFSeConfig } from '@nfewizard/types';
import { join } from 'node:path';

export interface NfseConfigInput {
  cnpj: string;
  uf: string;
  ambiente: 1 | 2;
  certPath: string;
  certPassword: string;
  outputDir: string;
}

export function criarNfseConfig(input: NfseConfigInput): NFSeConfig {
  return {
    dfe: {
      armazenarXMLAutorizacao: true,
      pathXMLAutorizacao: join(input.outputDir, 'autorizacao'),
      armazenarXMLRetorno: true,
      pathXMLRetorno: join(input.outputDir, 'retorno'),
      armazenarXMLConsulta: true,
      pathXMLConsulta: join(input.outputDir, 'consulta'),
      pathCertificado: input.certPath,
      senhaCertificado: input.certPassword,
      UF: input.uf,
      CPFCNPJ: input.cnpj,
    },
    nfse: {
      ambiente: input.ambiente,
      versao: '1.01',
    },
    lib: {
      connection: { timeout: 30000 },
      log: {
        exibirLogNoConsole: false,
        armazenarLogs: false,
      },
      useForSchemaValidation: 'validateSchemaJsBased',
      assinaturaDPS: 'legado',
    },
  };
}
