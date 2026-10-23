import * as NFSeModule from '@nfewizard/nfse';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const nfseBundle = NFSeModule as typeof NFSeModule & { NFSE_NT009_PATCHED?: boolean };
const BUNDLE_GIBSCBS_RE = /cstExigeGibscbs\(cst\)\s*\{[\s\S]*?return \['000'\]\.includes\(cst\);/;
const require = createRequire(import.meta.url);
let bundlePatchVerificado = false;

export function bundleTemRegraGibscbs(caminho: string): boolean {
  return BUNDLE_GIBSCBS_RE.test(readFileSync(caminho, 'utf8'));
}

export function exigirMarcadoresBundle(cjsPath: string, esmPath: string): void {
  if (!bundleTemRegraGibscbs(cjsPath) || !bundleTemRegraGibscbs(esmPath)) {
    throw new Error(
      'Bundles CJS/ESM de @nfewizard/nfse sem a regra gIBSCBS por CST. Rode "npm run patch:apply".',
    );
  }
}

export function exigirBundlePatchado(): void {
  if (bundlePatchVerificado) return;
  if (nfseBundle.NFSE_NT009_PATCHED !== true) {
    throw new Error(
      'Bundle @nfewizard/nfse sem o patch NT 009. Rode "npm ci" e "npm run patch:apply".',
    );
  }
  const cjsPath = require.resolve('@nfewizard/nfse');
  exigirMarcadoresBundle(cjsPath, join(dirname(cjsPath), 'index.mjs'));
  bundlePatchVerificado = true;
}
