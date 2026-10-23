import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const prepareScript = join(import.meta.dirname, 'prepare.mjs');
const variaveisGitDoHook = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
]);
const ambienteSemConfigGit = Object.fromEntries(
  Object.entries(process.env)
    .filter(([nome]) => (
      !nome.startsWith('GIT_CONFIG_') && !variaveisGitDoHook.has(nome)
    )),
);

test('npm prepare nao falha fora de um checkout git', () => {
  const diretorioExtraido = mkdtempSync(join(tmpdir(), 'nfse-prepare-'));

  try {
    const resultado = spawnSync(process.execPath, [prepareScript], {
      cwd: diretorioExtraido,
      encoding: 'utf8',
    });

    assert.equal(
      resultado.status,
      0,
      resultado.stderr || resultado.stdout || 'prepare terminou com erro',
    );
  } finally {
    rmSync(diretorioExtraido, { recursive: true, force: true });
  }
});

test('npm prepare nao configura hooks no repositorio git pai', () => {
  const diretorioPai = mkdtempSync(join(tmpdir(), 'nfse-prepare-parent-'));
  const diretorioExtraido = join(diretorioPai, 'projeto');
  mkdirSync(diretorioExtraido);

  try {
    const init = spawnSync('git', ['init', '--quiet'], {
      cwd: diretorioPai,
      encoding: 'utf8',
      env: ambienteSemConfigGit,
    });
    assert.equal(
      init.status,
      0,
      init.error?.message || init.stderr || 'git init terminou com erro',
    );

    const configureParent = spawnSync(
      'git',
      ['config', '--local', 'core.hooksPath', 'parent-hooks'],
      { cwd: diretorioPai, encoding: 'utf8', env: ambienteSemConfigGit },
    );
    assert.equal(
      configureParent.status,
      0,
      configureParent.error?.message
        || configureParent.stderr
        || 'configuracao do repositorio pai terminou com erro',
    );

    const resultado = spawnSync(process.execPath, [prepareScript], {
      cwd: diretorioExtraido,
      encoding: 'utf8',
      env: ambienteSemConfigGit,
    });

    assert.equal(
      resultado.status,
      0,
      resultado.stderr || resultado.stdout || 'prepare terminou com erro',
    );

    const hooks = spawnSync(
      'git',
      ['config', '--local', '--get', 'core.hooksPath'],
      { cwd: diretorioPai, encoding: 'utf8', env: ambienteSemConfigGit },
    );
    assert.equal(hooks.status, 0);
    assert.equal(hooks.stdout.trim(), 'parent-hooks');
  } finally {
    rmSync(diretorioPai, { recursive: true, force: true });
  }
});
