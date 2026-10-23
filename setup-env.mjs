import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function envValue(value) {
  const text = String(value ?? '');
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('`')) return `\`${text}\``;
  if (!text.includes('"') && !text.includes('\\')) return `"${text}"`;

  const impediments = [
    ['aspas simples', "'"],
    ['crase', '`'],
    ['aspas duplas', '"'],
    ['barra invertida', '\\'],
  ]
    .filter(([, caractere]) => text.includes(caractere))
    .map(([nome, caractere]) => `${nome} (${caractere})`);
  throw new Error(`Nenhum delimitador seguro para valor do .env: ${impediments.join(', ')}.`);
}

export function renderEnv({
  cnpj,
  im,
  uf,
  codMun,
  certPath,
  certPass,
  ambiente,
  opSimpNac,
  regAp,
  pTot,
  resendKey,
  resendFrom,
}) {
  return `# Gerado por "nfse setup". Este arquivo tem segredos: nunca versionar.

# Prestador
NFSE_CNPJ=${envValue(cnpj)}
NFSE_IM=${envValue(im)}
NFSE_UF=${envValue(uf)}
NFSE_COD_MUNICIPIO=${envValue(codMun)}

# Certificado A1 e-CNPJ
NFSE_CERT_PATH=${envValue(certPath)}
NFSE_CERT_PASSWORD=${envValue(certPass)}

# 1 = producao (irreversivel) | 2 = producao restrita
NFSE_AMBIENTE=${envValue(ambiente)}
NFSE_OUTPUT_DIR=${envValue('')}

# Tributacao
NFSE_OP_SIMP_NAC=${envValue(opSimpNac)}
NFSE_REG_AP_TRIB_SN=${envValue(regAp)}
NFSE_REG_ESP_TRIB=${envValue('0')}
NFSE_P_TOT_TRIB_SN=${envValue(pTot)}

# E-mail (Resend)
RESEND_API_KEY=${envValue(resendKey)}
RESEND_FROM_NOTAS=${envValue(resendFrom)}
`;
}

const defaultFileSystem = { chmodSync, renameSync, unlinkSync, writeFileSync };

export function writeEnvFile(path, content, fileSystem = defaultFileSystem) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`,
  );

  try {
    fileSystem.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fileSystem.chmodSync(temporaryPath, 0o600);
    try {
      fileSystem.renameSync(temporaryPath, path);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'EPERM' && code !== 'EEXIST') throw error;

      const backupPath = join(
        dirname(path),
        `.${basename(path)}.${randomBytes(16).toString('hex')}.bak`,
      );
      fileSystem.renameSync(path, backupPath);
      try {
        fileSystem.renameSync(temporaryPath, path);
      } catch (secondError) {
        fileSystem.renameSync(backupPath, path);
        throw secondError;
      }
      fileSystem.unlinkSync(backupPath);
    }
  } catch (error) {
    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch {
      // O temporário já foi renomeado ou não chegou a ser criado.
    }
    throw error;
  }
}
