import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';

const bundlePath = new URL('./ca_bundle.crt', import.meta.url);

function certificadosDoBundle() {
  const pem = readFileSync(bundlePath, 'utf8');
  return pem
    .split('-----END CERTIFICATE-----')
    .filter((parte) => parte.includes('-----BEGIN CERTIFICATE-----'))
    .map((parte) => new X509Certificate(`${parte}-----END CERTIFICATE-----`));
}

test('bundle de CA nao contem certificado folha do servidor', () => {
  const certificados = certificadosDoBundle();

  assert.ok(certificados.length > 0, 'o bundle precisa conter uma CA');
  for (const certificado of certificados) {
    assert.equal(
      certificado.ca,
      true,
      `certificado nao-CA no bundle: ${certificado.subject}`,
    );
  }
});
