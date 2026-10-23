import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** Ativa o hook apenas quando a instalação ainda está dentro de um checkout. */
export function configureGitHooks(cwd = process.cwd()) {
  let workTreeRoot;

  try {
    const insideWorkTree = execFileSync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (insideWorkTree !== 'true') {
      return false;
    }

    workTreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return false;
  }

  const canonicalCwd = realpathSync.native(cwd);
  const canonicalWorkTreeRoot = realpathSync.native(workTreeRoot);
  if (
    process.platform === 'win32'
      ? canonicalCwd.toLowerCase() !== canonicalWorkTreeRoot.toLowerCase()
      : canonicalCwd !== canonicalWorkTreeRoot
  ) {
    return false;
  }

  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd,
    stdio: 'inherit',
  });
  return true;
}

configureGitHooks();
