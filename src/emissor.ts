/**
 * Lógica de emissão NFS-e pelo padrão nacional (SEFIN Nacional).
 * Prestador vem do `.env` via config.ts; tomador/serviço/valores vêm do chamador.
 */

import NFSe from '@nfewizard/nfse';
import type { NFSe as NFSeType, NFSeConfig } from '@nfewizard/types';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';

import { config, exigirCertificado } from './config.js';
import { conferirDps } from './dps-xml.js';
import {
  exigirLeiauteNovoPermitido,
  montarDps as montarDpsPuro,
} from './montar-dps.js';
import type { EmissaoInput } from './montar-dps.js';
import { exigirEmissaoValida } from './validar-emissao.js';
import { criarNfseConfig } from './nfse-config.js';
import { silenciarLogsNfseWizard } from './nfewizard-logging.js';
import { ErroAntesDoEnvio } from './emissao-erros.js';
import { textoErroSefin } from './diagnostico-sefin.js';
import { exigirBundlePatchado } from './emissor-preflight.js';

// A montagem da DPS vive em montar-dps.ts (puro, testavel sem certificado).
// Reexportado aqui para os chamadores existentes.
export type { EmissaoInput, TomadorEndereco } from './montar-dps.js';

type NfseWizard = Pick<NFSe, 'Autorizacao'>;
type CriarNfseWizard = (nfseConfig: NFSeConfig) => NfseWizard;

export interface EmitirNfseOptions {
  outputDir?: string;
  criarWizard?: CriarNfseWizard;
}

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
const CA_BUNDLE_PATH = join(import.meta.dirname, '..', 'certs', 'ca_bundle.crt');
if (existsSync(CA_BUNDLE_PATH)) {
  https.globalAgent = new https.Agent({
    ca: readFileSync(CA_BUNDLE_PATH),
    keepAlive: true,
    rejectUnauthorized: true,
  });
} else {
  console.warn('[emissor] AVISO: certs/ca_bundle.crt nao encontrado, TLS pode falhar');
}

export { DEFAULTS } from './montar-dps.js';

// Instância lazy — criada apenas quando emitirNfse() é chamado (modo real).
// Não inicializar no topo do módulo: requer openssl + certificado, que falham
// em simulação onde só montarDps() é importado.
let _nfseWizard: NfseWizard | null = null;

function getNfseWizard(
  outputDir: string,
  criarWizard?: CriarNfseWizard,
): NfseWizard {
  if (outputDir === OUTPUT_DIR && _nfseWizard) return _nfseWizard;
  if (!criarWizard) exigirCertificado();
  const nfseConfig = criarNfseConfig({
    cnpj: config.cnpj,
    uf: config.uf,
    ambiente: config.ambiente,
    certPath: CERT_PATH,
    certPassword: CERT_PASSWORD,
    outputDir,
  });
  // Ticket #9 uses the current DPS layout; do not re-enable the legacy signature.
  delete nfseConfig.lib?.assinaturaDPS;
  silenciarLogsNfseWizard();
  const criado = criarWizard ? criarWizard(nfseConfig) : new NFSe(nfseConfig);
  if (outputDir === OUTPUT_DIR) _nfseWizard = criado;
  return criado;
}

export async function emitirNfse(
  input: EmissaoInput,
  antesDoEnvio?: () => void,
  options: EmitirNfseOptions = {},
) {
  const outputDir = options.outputDir ?? OUTPUT_DIR;
  let nfseData: NFSeType;
  let wizard: NfseWizard;
  try {
    exigirLeiauteNovoPermitido(config.ambiente);
    exigirBundlePatchado();
    exigirEmissaoValida(input);
    const conferencia = await conferirDps(input, config);
    if (!conferencia.ok) throw new Error(`DPS inválida: ${conferencia.msg}`);
    nfseData = { DPS: montarDps(input) as unknown as NFSeType['DPS'] };
    wizard = getNfseWizard(outputDir, options.criarWizard);
    antesDoEnvio?.();
  } catch (erro: unknown) {
    if (erro instanceof ErroAntesDoEnvio) throw erro;
    const mensagem = textoErroSefin(erro) || 'Falha antes do envio';
    throw new ErroAntesDoEnvio(`Falha antes do envio: ${mensagem}`, { cause: erro });
  }

  const resultado = await wizard.Autorizacao(nfseData);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, `resultado-ndps-${input.nDPS}.json`),
    JSON.stringify(resultado, null, 2),
    'utf-8',
  );
  return resultado;
}
