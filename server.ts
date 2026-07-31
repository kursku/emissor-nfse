/**
 * Painel local de emissao NFS-e. Uso: npx tsx server.ts (em scripts-ts/).
 * NAO expor fora de localhost: usa certificado digital real e emite documento fiscal.
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { emitirNfse, DEFAULTS, OUTPUT_DIR, EmissaoInput } from './emissor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NDPS_FILE = join(OUTPUT_DIR, 'ndps.json');
const DB_PATH = join(__dirname, 'output', 'emissor.db');

// --- Helpers NDPS (legado -- formulario manual) ---

function proximoNDPS(): number {
  if (!existsSync(NDPS_FILE)) return 1;
  return JSON.parse(readFileSync(NDPS_FILE, 'utf-8')).proximoNDPS;
}

function salvarProximoNDPS(n: number) {
  writeFileSync(NDPS_FILE, JSON.stringify({ proximoNDPS: n }), 'utf-8');
}

// --- Helper DB (read-only, sem importar store.ts) ---

function openDb(): DatabaseSync | null {
  if (!existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH, { open: true });
  db.exec('PRAGMA journal_mode=WAL;');
  return db;
}

// --- Helper spawn ---

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runSpawn(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // .cmd files executam sem shell no Node/Windows (spawn resolve o ShellExecute interno).
    // shell:false preserva args com espacos sem escaping adicional.
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: stderr + '\n' + String(err) });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

// --- Mascara CPF/CNPJ: 3 primeiros + 2 ultimos digitos ---

function mascaraDoc(doc: string | undefined | null): string {
  if (!doc) return '';
  const d = doc.replace(/\D/g, '');
  if (d.length < 5) return d;
  return d.slice(0, 3) + '...' + d.slice(-2);
}

// --- App ---

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'painel.html'));
});

app.get('/api/defaults', (_req, res) => {
  res.json({ ...DEFAULTS, nDPS: String(proximoNDPS()) });
});

app.get('/api/config', (_req, res) => {
  res.json({
    modoSimulacao: process.env['EMITIR_REAL'] !== '1',
    emitirReal: process.env['EMITIR_REAL'] === '1',
  });
});

app.get('/api/vendas/resumo', (_req, res) => {
  const db = openDb();
  if (!db) {
    res.json({ total: 0, simulada: 0, pendente_cadastro: 0, aguardando_garantia: 0, excecao: 0, emitida: 0, erro: 0, pronta: 0 });
    return;
  }
  try {
    const rows = db
      .prepare('SELECT status, COUNT(*) as n FROM vendas GROUP BY status')
      .all() as Array<{ status: string; n: number }>;

    const contagem: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      contagem[r.status] = r.n;
      total += r.n;
    }

    res.json({
      total,
      simulada: contagem['simulada'] ?? 0,
      pendente_cadastro: contagem['pendente_cadastro'] ?? 0,
      aguardando_garantia: contagem['aguardando_garantia'] ?? 0,
      excecao: contagem['excecao'] ?? 0,
      emitida: contagem['emitida'] ?? 0,
      erro: contagem['erro'] ?? 0,
      pronta: contagem['pronta'] ?? 0,
    });
  } finally {
    db.close();
  }
});

app.get('/api/vendas', (req, res) => {
  const db = openDb();
  if (!db) {
    res.json({ vendas: [], total: 0, page: 1, pages: 0 });
    return;
  }

  try {
    const { status, fila, q, page } = req.query as Record<string, string | undefined>;
    const PAGE_SIZE = 50;
    const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const offset = (pageNum - 1) * PAGE_SIZE;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (fila) {
      conditions.push('fila = ?');
      params.push(fila);
    }
    if (q) {
      conditions.push('(LOWER(nome) LIKE ? OR LOWER(email) LIKE ?)');
      const like = '%' + q.toLowerCase() + '%';
      params.push(like, like);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRow = db
      .prepare('SELECT COUNT(*) as n FROM vendas ' + where)
      .get(...params) as { n: number };
    const totalCount = countRow.n;

    const rows = db
      .prepare(
        'SELECT id_venda, data_venda, produto, nome, cpf_cnpj, valor, status, fila, erro' +
        ' FROM vendas ' + where +
        ' ORDER BY data_venda DESC' +
        ' LIMIT ? OFFSET ?',
      )
      .all(...params, PAGE_SIZE, offset) as Array<{
        id_venda: string;
        data_venda: string | null;
        produto: string | null;
        nome: string | null;
        cpf_cnpj: string | null;
        valor: number | null;
        status: string | null;
        fila: string | null;
        erro: string | null;
      }>;

    const vendas = rows.map((r) => ({
      ...r,
      cpf_cnpj: mascaraDoc(r.cpf_cnpj),
    }));

    res.json({ vendas, total: totalCount, page: pageNum, pages: Math.ceil(totalCount / PAGE_SIZE) });
  } finally {
    db.close();
  }
});

// Invoca tsx via "node tsx/dist/cli.mjs" para evitar shims (.cmd/.ps1) no Windows.
// Usa process.execPath (node.exe) diretamente -- preserva args com espacos.
function spawnTsx(scriptPath: string, extraArgs: string[], env?: NodeJS.ProcessEnv): Promise<SpawnResult> {
  const tsxCli = join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const nodeArgs = existsSync(tsxCli)
    ? [tsxCli, scriptPath, ...extraArgs]
    : ['--import', 'tsx', scriptPath, ...extraArgs]; // fallback sem cli.mjs
  return runSpawn(process.execPath, nodeArgs, env);
}

app.post('/api/importar', async (req, res) => {
  const { path: xlsxPath } = req.body as { path?: string };
  if (!xlsxPath) {
    res.status(400).json({ erro: 'Campo obrigatorio: path' });
    return;
  }

  const scriptPath = join(__dirname, 'integracoes', 'importar-lastlink.ts');
  const result = await spawnTsx(scriptPath, [xlsxPath]);

  if (result.exitCode !== 0) {
    res.status(500).json({ erro: 'Falha na importacao', detalhes: result.stderr || result.stdout });
    return;
  }

  res.json({ ok: true, resumo: result.stdout.trim() });
});

app.post('/api/simular', async (req, res) => {
  const { limite } = req.body as { limite?: number };

  const scriptPath = join(__dirname, 'fila.ts');
  const extraArgs: string[] = [];
  if (limite && limite > 0) {
    extraArgs.push('--limite', String(limite));
  }

  const result = await spawnTsx(scriptPath, extraArgs, { EMITIR_REAL: '' });

  if (result.exitCode !== 0) {
    res.status(500).json({ erro: 'Falha na simulacao', detalhes: result.stderr || result.stdout });
    return;
  }

  res.json({ ok: true, resumo: result.stdout.trim() });
});

app.post('/api/retry', async (req, res) => {
  const { id_venda } = req.body as { id_venda?: string };
  if (!id_venda) {
    res.status(400).json({ erro: 'Campo obrigatorio: id_venda' });
    return;
  }

  const db = openDb();
  if (!db) {
    res.status(503).json({ erro: 'Banco nao encontrado' });
    return;
  }

  try {
    const venda = db
      .prepare('SELECT id_venda, status, fila FROM vendas WHERE id_venda = ?')
      .get(id_venda) as { id_venda: string; status: string; fila: string } | undefined;

    if (!venda) {
      res.status(404).json({ erro: 'Venda nao encontrada' });
      return;
    }

    if (venda.status !== 'erro') {
      res.status(400).json({ erro: 'Venda nao esta em erro (status atual: ' + venda.status + ')' });
      return;
    }

    const novoStatus = venda.fila === 'pronta' ? 'pronta' : venda.fila;
    const now = new Date().toISOString();
    db.prepare('UPDATE vendas SET status = ?, erro = NULL, atualizada_em = ? WHERE id_venda = ?')
      .run(novoStatus, now, id_venda);
  } finally {
    db.close();
  }

  res.json({ ok: true, mensagem: 'Venda voltou para fila. Use "Simular" para processar.' });
});

app.post('/api/emitir', async (req, res) => {
  const input = req.body as EmissaoInput;
  if (!input?.tomador?.CNPJ || !input?.vServ || !input?.nDPS) {
    res.status(400).json({ erro: 'Campos obrigatorios: nDPS, tomador.CNPJ, vServ' });
    return;
  }
  console.log('[server] Emitindo DPS ' + input.nDPS + ' para ' + input.tomador.xNome + '...');
  try {
    const resultado = await emitirNfse(input);
    const chave = (resultado as Record<string, unknown>)?.['chaveAcesso'] as string | undefined;
    if (chave) salvarProximoNDPS(Number(input.nDPS) + 1);
    res.json({ autorizada: Boolean(chave), chaveAcesso: chave ?? null, resultado });
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data?: unknown } };
    console.error('[server] Erro na emissao:', e?.message);
    res.status(502).json({
      erro: e?.message ?? String(err),
      respostaSefin: e?.response?.data ?? null,
    });
  }
});

const PORT = 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log('Painel NFS-e (PRODUCAO REAL): http://localhost:' + PORT);
});
