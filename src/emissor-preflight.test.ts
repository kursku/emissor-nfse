import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  bundleTemRegraGibscbs,
  exigirMarcadoresBundle,
} from './emissor-preflight.js';

const require = createRequire(import.meta.url);
const cjsPath = require.resolve('@nfewizard/nfse');
const esmPath = join(dirname(cjsPath), 'index.mjs');

test('preflight falha com bundle sem a regra gIBSCBS por CST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nfse-preflight-gibscbs-'));
  const cjsCopy = join(dir, 'index.cjs');
  const esmCopy = join(dir, 'index.mjs');

  try {
    const cjsSemRegra = readFileSync(cjsPath, 'utf8').replace(
      'cstExigeGibscbs(cst)',
      'cstExigeGibscbsRemovida(cst)',
    );
    writeFileSync(cjsCopy, cjsSemRegra, 'utf8');
    copyFileSync(esmPath, esmCopy);

    assert.equal(bundleTemRegraGibscbs(cjsCopy), false);
    assert.equal(bundleTemRegraGibscbs(esmCopy), true);
    assert.throws(
      () => exigirMarcadoresBundle(cjsCopy, esmCopy),
      /regra gIBSCBS por CST/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
