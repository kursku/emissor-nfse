import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { renderEnv, writeEnvFile } from './setup-env.mjs';

const ENV_KEYS = [
  'NFSE_CNPJ',
  'NFSE_IM',
  'NFSE_UF',
  'NFSE_COD_MUNICIPIO',
  'NFSE_CERT_PATH',
  'NFSE_CERT_PASSWORD',
  'NFSE_AMBIENTE',
  'NFSE_OUTPUT_DIR',
  'NFSE_OP_SIMP_NAC',
  'NFSE_REG_AP_TRIB_SN',
  'NFSE_REG_ESP_TRIB',
  'NFSE_P_TOT_TRIB_SN',
  'RESEND_API_KEY',
  'RESEND_FROM_NOTAS',
];

function envContent(certPass) {
  return renderEnv({
    cnpj: '11222333000181',
    im: '12345',
    uf: 'SP',
    codMun: '3509502',
    certPath: 'C:/certificado.p12',
    certPass,
    ambiente: '2',
    opSimpNac: '3',
    regAp: '1',
    pTot: '6.00',
    resendKey: '',
    resendFrom: '',
  });
}

async function assertPasswordRoundTrip(password, delimiter) {
  const dir = await mkdtemp(join(tmpdir(), 'nfse-setup-'));
  const envPath = join(dir, '.env');
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    delete process.env.NFSE_CERT_PASSWORD;
    writeEnvFile(envPath, envContent(password));

    process.loadEnvFile(envPath);
    assert.equal(process.env.NFSE_CERT_PASSWORD, password);
    assert.match(await readFile(envPath, 'utf8'), new RegExp(`NFSE_CERT_PASSWORD=${delimiter}`));
    if (process.platform !== 'win32') {
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('renderEnv preserva senha com aspas duplas e barra invertida', async () => {
  await assertPasswordRoundTrip(String.raw`senha"com\barra`, "'");
});

test('renderEnv preserva senha com #', async () => {
  await assertPasswordRoundTrip('senha#123', "'");
});

test("renderEnv preserva senha com aspas simples usando crase", async () => {
  await assertPasswordRoundTrip('senha\'com"barra', '`');
});

test('renderEnv preserva a sequência literal \\n', async () => {
  await assertPasswordRoundTrip(String.raw`senha\nliteral`, "'");
});

test('renderEnv recusa senha sem delimitador seguro e informa os caracteres', () => {
  const password = "a'b`c\"\\d";

  assert.throws(
    () => envContent(password),
    (error) => {
      assert.match(error.message, /delimitador seguro/);
      assert.match(error.message, /aspas simples/);
      assert.match(error.message, /crase/);
      assert.match(error.message, /aspas duplas/);
      assert.match(error.message, /barra invertida/);
      return true;
    },
  );
});

test('writeEnvFile escreve temporário 0600 e renomeia na mesma pasta', () => {
  const envPath = join(tmpdir(), 'nfse-atomic-test', '.env');
  const writes = [];
  let renamed;
  const fakeFs = {
    writeFileSync(path, content, options) {
      writes.push({ path, content, options });
    },
    chmodSync(path, mode) {
      writes.push({ path, mode });
    },
    renameSync(source, target) {
      renamed = { source, target };
    },
    unlinkSync() {},
  };

  writeEnvFile(envPath, 'novo', fakeFs);

  assert.equal(writes[0].options.flag, 'wx');
  assert.equal(writes[0].options.mode, 0o600);
  assert.equal(writes[1].mode, 0o600);
  assert.equal(dirname(writes[0].path), dirname(envPath));
  assert.deepEqual(renamed, { source: writes[0].path, target: envPath });
});

test('writeEnvFile restaura .env original quando a segunda renomeação falha', () => {
  const envPath = join(tmpdir(), 'nfse-atomic-test', '.env');
  const original = 'configuracao original com senha';
  const files = new Map([[envPath, original]]);
  const firstError = Object.assign(new Error('destino ocupado'), { code: 'EPERM' });
  const secondError = Object.assign(new Error('renomeacao bloqueada'), { code: 'EPERM' });
  let renameCount = 0;
  let backupPath;
  const fakeFs = {
    writeFileSync(path, content) {
      files.set(path, content);
    },
    chmodSync() {},
    renameSync(source, target) {
      renameCount++;
      if (renameCount === 1) throw firstError;
      if (renameCount === 2) {
        backupPath = target;
        files.set(target, files.get(source));
        files.delete(source);
        return;
      }
      if (renameCount === 3) throw secondError;
      if (renameCount === 4) {
        files.set(target, files.get(source));
        files.delete(source);
        return;
      }
      throw new Error('renomeacao inesperada');
    },
    unlinkSync(path) {
      files.delete(path);
    },
  };

  assert.throws(() => writeEnvFile(envPath, 'nova configuracao', fakeFs), (error) => error === secondError);
  assert.equal(renameCount, 4);
  assert.equal(dirname(backupPath), dirname(envPath));
  assert.equal(files.get(envPath), original);
  assert.equal(files.size, 1);
});

test('writeEnvFile deixa .env existente com permissão 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nfse-setup-'));
  const envPath = join(dir, '.env');

  try {
    await writeFile(envPath, 'antigo', { encoding: 'utf8', mode: 0o644 });
    if (process.platform !== 'win32') await chmod(envPath, 0o644);
    writeEnvFile(envPath, 'novo');
    assert.equal(await readFile(envPath, 'utf8'), 'novo');
    if (process.platform !== 'win32') {
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
