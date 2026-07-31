/**
 * config.ts — identidade do prestador e parâmetros fiscais, lidos do ambiente.
 *
 * Nenhum default de produção: variável obrigatória ausente derruba o processo
 * com mensagem clara. Preencha o `.env` (ver `.env.example`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { cnpjInvalido, codMunicipioInvalido } from './validacoes.mjs';

// `.env` fica na mesma pasta do código (Node >= 20.12).
try {
  process.loadEnvFile(join(import.meta.dirname, '.env'));
} catch {
  /* sem .env — segue com o ambiente do shell */
}

function obrigatoria(nome: string, formato: string): string {
  const v = process.env[nome]?.trim();
  if (!v) {
    console.error(
      `Configuração ausente: ${nome} (${formato}).\n` +
        `Preencha no arquivo .env — veja .env.example.`,
    );
    process.exit(1);
  }
  return v;
}

function opcional(nome: string, padrao: string): string {
  return process.env[nome]?.trim() || padrao;
}

/** Lê um código numérico do ambiente e recusa valor fora da lista do layout. */
function codigo<T extends number>(nome: string, padrao: T, permitidos: readonly T[]): T {
  const v = Number(opcional(nome, String(padrao)));
  if (!permitidos.includes(v as T)) {
    console.error(`${nome} inválido: "${v}" — valores aceitos: ${permitidos.join(', ')}.`);
    process.exit(1);
  }
  return v as T;
}

/** Aplica um validador de `validacoes.mjs` e derruba o processo com o motivo. */
function validado(
  nome: string,
  valor: string,
  valida: (v: string) => string | null,
): string {
  const problema = valida(valor);
  if (problema) {
    console.error(`${nome} inválido: ${problema}`);
    process.exit(1);
  }
  return valor.replace(/\D/g, '');
}

const CNPJ = validado(
  'NFSE_CNPJ',
  obrigatoria('NFSE_CNPJ', 'CNPJ do prestador, 14 dígitos'),
  cnpjInvalido,
);
const COD_MUNICIPIO = validado(
  'NFSE_COD_MUNICIPIO',
  obrigatoria('NFSE_COD_MUNICIPIO', 'código IBGE do município, 7 dígitos'),
  codMunicipioInvalido,
);
const CERT_PATH = obrigatoria('NFSE_CERT_PATH', 'caminho absoluto do certificado A1 .p12');

/**
 * Confere que o certificado existe no disco. Chamado no ponto de uso (emissão,
 * DANFSe, consultas), não na carga: simular a fila e montar a DPS não precisam
 * de certificado, e exigir o arquivo aqui impedia testar antes de tê-lo.
 */
export function exigirCertificado(): void {
  if (!existsSync(CERT_PATH)) {
    console.error(`Certificado não encontrado em NFSE_CERT_PATH: ${CERT_PATH}`);
    process.exit(1);
  }
}

export const config = {
  /** CNPJ do prestador, só dígitos */
  cnpj: CNPJ,
  /** Inscrição Municipal na prefeitura (exigida no cadastro CNC — erro E0116 sem ela) */
  im: obrigatoria('NFSE_IM', 'Inscrição Municipal'),
  uf: obrigatoria('NFSE_UF', 'sigla do estado, ex.: SP').toUpperCase(),
  /** Código IBGE do município do prestador — local de emissão e de prestação */
  codMunicipio: COD_MUNICIPIO,
  certPath: CERT_PATH,
  certPassword: obrigatoria('NFSE_CERT_PASSWORD', 'senha do .p12'),
  /**
   * 1 = produção (nota real, irreversível); 2 = produção restrita/homologação.
   * Default 2: campo em branco tem que cair no lado seguro — emitir de verdade
   * exige declarar NFSE_AMBIENTE=1 de propósito.
   */
  ambiente: codigo('NFSE_AMBIENTE', 2 as 1 | 2, [1, 2]),
  outputDir: opcional('NFSE_OUTPUT_DIR', join(import.meta.dirname, 'output', 'nfewizard')),
  /**
   * Regime tributário. opSimpNac: 1 não optante, 2 MEI, 3 ME/EPP.
   * regApTribSN só se aplica a ME/EPP (obrigatório nesse caso — erro E0166).
   */
  regTrib: {
    opSimpNac: codigo('NFSE_OP_SIMP_NAC', 3 as 1 | 2 | 3, [1, 2, 3]),
    regApTribSN: codigo('NFSE_REG_AP_TRIB_SN', 1 as 1 | 2 | 3, [1, 2, 3]),
    regEspTrib: codigo('NFSE_REG_ESP_TRIB', 0 as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 9, [
      0, 1, 2, 3, 4, 5, 6, 9,
    ]),
  },
  /** % aproximado de tributos do Simples (Lei da Transparência): Anexo III = 6,00; Anexo V = 15,50 */
  pTotTribSN: Number(opcional('NFSE_P_TOT_TRIB_SN', '6.00')),
} as const;
