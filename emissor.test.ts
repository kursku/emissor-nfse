import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("certificado ausente é sinalizado como falha antes do envio", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nfse-emissor-pre-envio-"));
  const script = `
    import { emitirNfse } from './emissor.ts';
    import { ErroAntesDoEnvio } from './emissao-erros.ts';
    const input = {
      nDPS: '1',
      tomador: {
        CNPJ: '11444777000161',
        xNome: 'Tomador',
        end: { cMun: '3509502', CEP: '13000000', xLgr: 'Rua', nro: '1', xBairro: 'Centro' }
      },
      xDescServ: 'Servico', vServ: 100, cTribNac: '080201', cNBS: '122051900',
      cIndOp: '100301', cClassTrib: '000001'
    };
    try {
      await emitirNfse(input);
      process.exit(2);
    } catch (erro) {
      if (erro instanceof ErroAntesDoEnvio) console.log('typed');
      else process.exit(3);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NFSE_CNPJ: "11444777000161",
        NFSE_COD_MUNICIPIO: "3509502",
        NFSE_CERT_PATH: join(outputDir, "inexistente.p12"),
        NFSE_CERT_PASSWORD: "teste",
        NFSE_IM: "1",
        NFSE_UF: "SP",
        NFSE_AMBIENTE: "2",
        NFSE_OUTPUT_DIR: outputDir,
      },
    },
  );
  rmSync(outputDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /typed/);
});
