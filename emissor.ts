/**
 * Lógica de emissão NFS-e pelo padrão nacional (SEFIN Nacional).
 * Prestador vem do `.env` via config.ts; tomador/serviço/valores vêm do chamador.
 */

import NFSe from '@nfewizard/nfse';
import { NFSe as NFSeType } from '@nfewizard/types';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';

import { config, exigirCertificado } from './config.js';
import { montarDps as montarDpsPuro } from './montar-dps.js';
import type { EmissaoInput } from './montar-dps.js';

// A montagem da DPS vive em montar-dps.ts (puro, testavel sem certificado).
// Reexportado aqui para os chamadores existentes.
export type { EmissaoInput, TomadorEndereco } from './montar-dps.js';

/** Monta a DPS com a configuração do prestador vinda do `.env`. */
export const montarDps = (input: EmissaoInput) => montarDpsPuro(input, config);

// A lib chama `openssl pkcs12 -legacy` (o .p12 usa cifra antiga). O openssl do
// Git em usr/bin procura o provider legacy num path MSYS que nao existe no
// Windows; o de mingw64 funciona com OPENSSL_MODULES apontado para os modulos.
const GIT_OPENSSL_BIN = 'C:/Program Files/Git/mingw64/bin';
const GIT_OSSL_MODULES = 'C:/Program Files/Git/mingw64/lib/ossl-modules';
if (process.platform === 'win32' && existsSync(GIT_OSSL_MODULES)) {
  process.env['OPENSSL_MODULES'] ??= GIT_OSSL_MODULES;
  if (!(process.env['PATH'] ?? '').includes(GIT_OPENSSL_BIN)) {
    process.env['PATH'] = `${GIT_OPENSSL_BIN};${process.env['PATH'] ?? ''}`;
  }
}

export const CERT_PATH = config.certPath;
export const CERT_PASSWORD = config.certPassword;
export const OUTPUT_DIR = config.outputDir;

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// SEFIN usa cadeia de CAs fora do cert store padrao do Node.
const CA_BUNDLE_PATH = join(import.meta.dirname, 'ca_bundle.crt');
if (existsSync(CA_BUNDLE_PATH)) {
  https.globalAgent = new https.Agent({
    ca: readFileSync(CA_BUNDLE_PATH),
    keepAlive: true,
    rejectUnauthorized: true,
  });
} else {
  console.warn('[emissor] AVISO: ca_bundle.crt nao encontrado, TLS pode falhar');
}

// Exemplo fictício — prefill do painel. Substitua pelos dados reais na emissão.
export const DEFAULTS: EmissaoInput = {
  nDPS: '1',
  tomador: {
    CNPJ: '00000000000000',
    xNome: 'EMPRESA EXEMPLO LTDA',
    end: {
      cMun: '0000000',
      CEP: '00000000',
      xLgr: 'Rua Exemplo',
      nro: '100',
      xBairro: 'Centro',
    },
    fone: '5500000000000',
    email: 'exemplo@exemplo.com.br',
  },
  xDescServ: 'Prestacao de servico de exemplo.',
  vServ: 100.0,
  cTribNac: '080201',
  cNBS: '122051900',
  cIndOp: '100301',
  cClassTrib: '000001',
};

// Instância lazy — criada apenas quando emitirNfse() é chamado (modo real).
// Não inicializar no topo do módulo: requer openssl + certificado, que falham
// em simulação onde só montarDps() é importado.
let _nfseWizard: NFSe | null = null;

function getNfseWizard(): NFSe {
  if (_nfseWizard) return _nfseWizard;
  exigirCertificado();
  _nfseWizard = new NFSe({
    dfe: {
      armazenarXMLAutorizacao: true,
      pathXMLAutorizacao: join(OUTPUT_DIR, 'autorizacao'),
      armazenarXMLRetorno: true,
      pathXMLRetorno: join(OUTPUT_DIR, 'retorno'),
      armazenarXMLConsulta: true,
      pathXMLConsulta: join(OUTPUT_DIR, 'consulta'),
      pathCertificado: CERT_PATH,
      senhaCertificado: CERT_PASSWORD,
      UF: config.uf,
      CPFCNPJ: config.cnpj,
    },
    nfse: {
      ambiente: config.ambiente, // 1 = producao real (irreversivel); 2 = producao restrita
      versao: '1.01',
    },
    nfe: {
      ambiente: config.ambiente,
      versaoDF: '4.00',
    },
    lib: {
      connection: { timeout: 30000 },
      log: {
        exibirLogNoConsole: true,
        armazenarLogs: true,
        pathLogs: join(OUTPUT_DIR, 'logs'),
      },
      useForSchemaValidation: 'validateSchemaJsBased',
    },
    // s any no objeto inteiro: @nfewizard/types nao exporta o tipo do
    // construtor, entao nao ha o que anotar campo a campo.
  } as any);
  return _nfseWizard;
}

export async function emitirNfse(input: EmissaoInput) {
  const nfseData: NFSeType = { DPS: montarDps(input) };
  const resultado = await getNfseWizard().Autorizacao(nfseData);
  writeFileSync(
    join(OUTPUT_DIR, `resultado-ndps-${input.nDPS}.json`),
    JSON.stringify(resultado, null, 2),
    'utf-8',
  );
  return resultado;
}
