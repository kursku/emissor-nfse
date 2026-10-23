import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("certificado ausente é sinalizado como falha antes do envio", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nfse-emissor-pre-envio-"));
  const script = `
    import { emitirNfse } from './src/emissor.ts';
    import { ErroAntesDoEnvio } from './src/emissao-erros.ts';
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

test("emissão com saída injetada configura e grava tudo fora da produção", () => {
  const productionDir = mkdtempSync(join(tmpdir(), "nfse-emissor-producao-"));
  const ensaioDir = mkdtempSync(join(tmpdir(), "nfse-emissor-ensaio-"));
  const script = `
    import { emitirNfse } from './src/emissor.ts';
    const input = {
      nDPS: '77',
      tomador: {
        CNPJ: '11444777000161',
        xNome: 'Tomador',
        end: { cMun: '3509502', CEP: '13000000', xLgr: 'Rua', nro: '1', xBairro: 'Centro' }
      },
      xDescServ: 'Servico', vServ: 100, cTribNac: '080201', cNBS: '122051900',
      cIndOp: '100301', cClassTrib: '000001'
    };
    const resposta = await emitirNfse(input, undefined, {
      outputDir: ${JSON.stringify(ensaioDir)},
      criarWizard: (nfseConfig) => {
        console.log('CONFIG ' + JSON.stringify({
          autorizacao: nfseConfig.dfe.pathXMLAutorizacao,
          retorno: nfseConfig.dfe.pathXMLRetorno,
          consulta: nfseConfig.dfe.pathXMLConsulta,
        }));
        return { Autorizacao: async () => ({ chNFSe: '8'.repeat(50) }) };
      },
    });
    console.log('RESULTADO ' + JSON.stringify(resposta));
  `;

  try {
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
          NFSE_CERT_PATH: join(productionDir, "inexistente.p12"),
          NFSE_CERT_PASSWORD: "teste",
          NFSE_IM: "1",
          NFSE_UF: "SP",
          NFSE_AMBIENTE: "2",
          NFSE_OUTPUT_DIR: productionDir,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const configLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("CONFIG "));
    assert.ok(configLine);
    const paths = JSON.parse(configLine.slice("CONFIG ".length)) as Record<string, string>;
    assert.deepEqual(paths, {
      autorizacao: join(ensaioDir, "autorizacao"),
      retorno: join(ensaioDir, "retorno"),
      consulta: join(ensaioDir, "consulta"),
    });
    assert.deepEqual(readdirSync(productionDir), []);
    assert.deepEqual(readdirSync(ensaioDir), ["resultado-ndps-77.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(ensaioDir, "resultado-ndps-77.json"), "utf8")), {
      chNFSe: "8".repeat(50),
    });
  } finally {
    rmSync(productionDir, { recursive: true, force: true });
    rmSync(ensaioDir, { recursive: true, force: true });
  }
});
