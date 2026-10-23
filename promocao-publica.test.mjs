import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = join(
  import.meta.dirname,
  'scripts',
  'promover-publico.ps1',
);

function encontrarPowerShell() {
  const candidatos = process.platform === 'win32'
    ? ['pwsh', 'powershell.exe']
    : ['pwsh'];

  for (const executavel of candidatos) {
    const resultado = spawnSync(
      executavel,
      ['-NoProfile', '-Command', 'exit 0'],
      { stdio: 'ignore' },
    );

    if (!resultado.error && resultado.status === 0) {
      return executavel;
    }
  }

  throw new Error(
    `Nenhum executável PowerShell disponível; tentados: ${candidatos.join(', ')}`,
  );
}

test('promocao publica exclui o checklist interno', () => {
  const diretorioTemporario = mkdtempSync(join(tmpdir(), 'nfse-promocao-'));
  const exportacao = join(diretorioTemporario, 'publico');

  try {
    const executavel = encontrarPowerShell();
    const resultado = spawnSync(
      executavel,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-OutputDirectory',
        exportacao,
      ],
      { cwd: join(import.meta.dirname), encoding: 'utf8' },
    );

    assert.equal(
      resultado.status,
      0,
      resultado.error?.message
        || resultado.stderr
        || resultado.stdout
        || 'promocao terminou com erro',
    );
    assert.equal(
      existsSync(join(exportacao, 'HIGIENIZACAO.md')),
      false,
    );
    assert.equal(existsSync(join(exportacao, 'README.md')), true);
  } finally {
    rmSync(diretorioTemporario, { recursive: true, force: true });
  }
});
