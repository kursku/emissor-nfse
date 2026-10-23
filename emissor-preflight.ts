import * as NFSeModule from '@nfewizard/nfse';

const nfseBundle = NFSeModule as typeof NFSeModule & { NFSE_NT009_PATCHED?: boolean };
let bundlePatchVerificado = false;

export function exigirBundlePatchado(): void {
  if (bundlePatchVerificado) return;
  if (nfseBundle.NFSE_NT009_PATCHED !== true) {
    throw new Error(
      'Bundle @nfewizard/nfse sem o patch NT 009. Rode "npm ci" e "npm run patch:apply".',
    );
  }
  bundlePatchVerificado = true;
}
