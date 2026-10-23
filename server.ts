/**
 * Painel local de emissao NFS-e. Uso: npx tsx server.ts (em scripts-ts/).
 * NAO expor fora de localhost: usa certificado digital real e emite documento fiscal.
 */

import express from 'express';
import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULTS, exigirLeiauteNovoPermitido } from './montar-dps.js';
import type { EmissaoInput } from './montar-dps.js';
import {
  concluirEmissao,
  criarEReservarEmissao,
  initDb,
  marcarTentativaAveriguar,
  marcarTentativaRejeitada,
  proximoNDPS,
  recolocarVendaNaFila,
  ConflitoEmissaoError,
} from './store.js';
import { mascaraDoc, mascararDocumentos } from './mascara.js';
import {
  extrairDiagnosticoSefin,
  textoDiagnosticoSefin,
  textoErroSefin,
} from './diagnostico-sefin.js';
import { exigirEmissaoValida } from './validar-emissao.js';
import {
  buscarChaveNoXmlPorNdps,
  classificarRespostaEmissao,
  MENSAGEM_CHAVE_A_VERIFICAR,
} from './chave-acesso.js';
import { ErroAntesDoEnvio, ehErroAntesDoEnvio } from './emissao-erros.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'output', 'emissor.db');
const PORT = 3000;

export const PAINEL_TOKEN_HEADER = 'X-Painel-Token';
export const IMPORT_DIR = join(__dirname, 'importacoes');
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_SESSION_TOKENS = 50;

// --- Helper DB para consultas do painel ---

function openDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { open: true });
  db.exec('PRAGMA journal_mode=WAL;');
  return db;
}

// --- Helper spawn ---

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

type SpawnTsx = (scriptPath: string, extraArgs: string[], env?: NodeJS.ProcessEnv) => Promise<SpawnResult>;

export interface PainelDependencies {
  panelPort?: number;
  importDir?: string;
  spawnTsx?: SpawnTsx;
  emitirNfse?: (input: EmissaoInput) => Promise<unknown>;
  criarEReservarEmissao?: typeof criarEReservarEmissao;
  marcarTentativaAveriguar?: typeof marcarTentativaAveriguar;
  marcarTentativaRejeitada?: typeof marcarTentativaRejeitada;
  buscarChaveNoXmlPorNdps?: typeof buscarChaveNoXmlPorNdps;
  outputDir?: string;
  dbPath?: string;
  defaults?: EmissaoInput;
  ambiente?: 1 | 2;
  agora?: Date;
  exigirBundlePatchado?: () => void;
  now?: () => number;
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
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + '\n' + (textoErroSefin(err) || 'falha ao iniciar processo'),
      });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

// Invoca tsx via "node tsx/dist/cli.mjs" para evitar shims (.cmd/.ps1) no Windows.
// Usa process.execPath (node.exe) diretamente -- preserva args com espacos.
const spawnTsx: SpawnTsx = (scriptPath, extraArgs, env) => {
  const tsxCli = join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const nodeArgs = existsSync(tsxCli)
    ? [tsxCli, scriptPath, ...extraArgs]
    : ['--import', 'tsx', scriptPath, ...extraArgs]; // fallback sem cli.mjs
  return runSpawn(process.execPath, nodeArgs, env);
};

export function resolverImportPath(pathName: unknown, importDir = IMPORT_DIR): string | null {
  if (typeof pathName !== 'string' || pathName.trim() === '') return null;
  const value = pathName.trim();
  if (value.startsWith('\\\\') || value.startsWith('//')) return null;
  if (value.replaceAll('/', '\\').split('\\').includes('..')) return null;
  if (/^[A-Za-z]:/.test(value) && !isAbsolute(value)) return null;

  const root = resolve(importDir);
  const candidate = resolve(isAbsolute(value) ? value : join(root, value));
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return null;
  }

  try {
    if (!lstatSync(candidate).isFile()) return null;
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const realFromRoot = relative(realRoot, realCandidate);
    if (!realFromRoot || realFromRoot === '..' || realFromRoot.startsWith(`..${sep}`) || isAbsolute(realFromRoot)) {
      return null;
    }
    return realCandidate;
  } catch {
    return null;
  }
}

function hostPermitido(host: string | undefined, panelPort: number, localPort?: number): boolean {
  if (!host) return false;
  const porta = panelPort === 0 ? localPort : panelPort;
  if (!porta) return false;
  const normalizado = host.trim().toLowerCase();
  return normalizado === `localhost:${porta}` || normalizado === `127.0.0.1:${porta}`;
}

function originPermitida(origin: string, panelPort: number, localPort?: number): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && hostPermitido(`${url.hostname}:${url.port}`, panelPort, localPort);
  } catch {
    return false;
  }
}

function tokenDeSessao(): string {
  return randomBytes(32).toString('hex');
}

function modoRealAtivo(): boolean {
  return process.env['EMITIR_REAL'] === '1';
}

function textoDiagnostico(valor: unknown): string {
  if (typeof valor === 'string') return valor;
  try {
    return JSON.stringify(valor) ?? String(valor);
  } catch {
    return String(valor);
  }
}

function logSpawnDiagnostico(tipo: string, result: SpawnResult): void {
  const detalhes = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  if (detalhes) console.error(`[server] ${tipo}:\n${mascararDocumentos(detalhes)}`);
}

function extrairCodigosSefin(valor: unknown): string[] {
  return [...new Set(textoDiagnostico(valor).match(/\b[EA]\d{3,4}\b/gi) ?? [])];
}

// --- Mascara CPF/CNPJ: 3 primeiros + 2 ultimos digitos — ver mascara.ts ---

// --- App ---

export function createPainelApp(deps: PainelDependencies = {}) {
  const panelPort = deps.panelPort ?? PORT;
  const importDir = deps.importDir ?? IMPORT_DIR;
  const now = deps.now ?? Date.now;
  const dbPath = deps.dbPath ?? DB_PATH;
  const buscarChave = deps.buscarChaveNoXmlPorNdps ?? buscarChaveNoXmlPorNdps;
  const reservar = deps.criarEReservarEmissao ?? criarEReservarEmissao;
  const marcarAveriguar = deps.marcarTentativaAveriguar ?? marcarTentativaAveriguar;
  const marcarRejeitada = deps.marcarTentativaRejeitada ?? marcarTentativaRejeitada;
  const tokens = new Map<string, number>();
  const runSpawn = deps.spawnTsx ?? spawnTsx;
  const app = express();
  if (deps.dbPath !== undefined) {
    initDb(dbPath);
  }

  function limparTokensExpirados(): void {
    const limite = now() - TOKEN_TTL_MS;
    for (const [token, criadoEm] of tokens) {
      if (criadoEm <= limite) tokens.delete(token);
    }
  }

  function registrarToken(token: string): void {
    limparTokensExpirados();
    while (tokens.size >= MAX_SESSION_TOKENS) {
      const maisAntigo = tokens.keys().next().value;
      if (typeof maisAntigo !== 'string') break;
      tokens.delete(maisAntigo);
    }
    tokens.set(token, now());
  }

  function tokenValido(token: string | undefined): boolean {
    if (!token) return false;
    const criadoEm = tokens.get(token);
    if (criadoEm === undefined) return false;
    if (now() - criadoEm >= TOKEN_TTL_MS) {
      tokens.delete(token);
      return false;
    }
    return true;
  }

  async function resolverOutputDir(): Promise<string | undefined> {
    if (deps.outputDir !== undefined) return deps.outputDir;
    if (!modoRealAtivo()) return undefined;
    const { config } = await import('./config.js');
    return config.outputDir;
  }

  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");

    const origin = req.get('origin');
    const localPort = req.socket.localPort;
    if (!hostPermitido(req.get('host'), panelPort, localPort) || (origin !== undefined && !originPermitida(origin, panelPort, localPort))) {
      res.status(403).json({ erro: 'Origem nao permitida' });
      return;
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const token = req.get(PAINEL_TOKEN_HEADER);
      if (!tokenValido(token)) {
        res.status(403).json({ erro: 'Token de sessao invalido' });
        return;
      }
    }

    next();
  });

  app.use(express.json());

  app.get('/', (_req, res) => {
    const token = tokenDeSessao();
    registrarToken(token);
    const html = readFileSync(join(__dirname, 'painel.html'), 'utf-8').replace(
      '</head>',
      `<meta name="painel-token" content="${token}"></head>`,
    );
    res.set('Cache-Control', 'no-store');
    res.set(PAINEL_TOKEN_HEADER, token);
    res.type('html').send(html);
  });

  app.get('/painel-payload.mjs', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').send(readFileSync(join(__dirname, 'painel-payload.mjs'), 'utf8'));
  });

  app.get('/api/defaults', async (_req, res) => {
    const defaults = deps.defaults ?? DEFAULTS;
    const outputDir = await resolverOutputDir();
    initDb(dbPath);
    res.json({ ...defaults, nDPS: String(proximoNDPS(outputDir)) });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      modoSimulacao: !modoRealAtivo(),
      emitirReal: modoRealAtivo(),
    });
  });

app.get('/api/vendas/resumo', (_req, res) => {
  const db = openDb(dbPath);
  if (!db) {
    res.json({
      total: 0,
      simulada: 0,
      pendente_cadastro: 0,
      aguardando_garantia: 0,
      excecao: 0,
      emitida: 0,
      a_verificar: 0,
      erro: 0,
      pronta: 0,
    });
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
      a_verificar: contagem['a_verificar'] ?? 0,
      erro: contagem['erro'] ?? 0,
      pronta: contagem['pronta'] ?? 0,
    });
  } finally {
    db.close();
  }
});

app.get('/api/vendas', (req, res) => {
  const db = openDb(dbPath);
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
      erro: r.erro ? mascararDocumentos(r.erro) : r.erro,
    }));

    res.json({ vendas, total: totalCount, page: pageNum, pages: Math.ceil(totalCount / PAGE_SIZE) });
  } finally {
    db.close();
  }
});

app.post('/api/importar', async (req, res) => {
  const { path: xlsxPath } = req.body as { path?: string };
  if (typeof xlsxPath !== 'string' || xlsxPath.trim() === '') {
    res.status(400).json({ erro: 'Campo obrigatorio: path' });
    return;
  }
  const resolvedPath = resolverImportPath(xlsxPath, importDir);
  if (!resolvedPath) {
    res.status(400).json({ erro: 'Arquivo fora da pasta de importacao' });
    return;
  }

  const scriptPath = join(__dirname, 'integracoes', 'importar-lastlink.ts');
  const result = await runSpawn(scriptPath, [resolvedPath]);
  logSpawnDiagnostico('Importacao', result);

  if (result.exitCode !== 0) {
    res.status(500).json({ erro: 'Falha na importacao' });
    return;
  }

  res.json({ ok: true, resumo: 'Importacao concluida.' });
});

app.post('/api/simular', async (req, res) => {
  const { limite } = req.body as { limite?: number };

  const scriptPath = join(__dirname, 'fila.ts');
  const extraArgs: string[] = [];
  if (limite && limite > 0) {
    extraArgs.push('--limite', String(limite));
  }

  const result = await runSpawn(scriptPath, extraArgs, { EMITIR_REAL: '' });
  logSpawnDiagnostico('Simulacao', result);

  if (result.exitCode !== 0) {
    res.status(500).json({ erro: 'Falha na simulacao' });
    return;
  }

  res.json({ ok: true, resumo: 'Simulacao concluida.' });
});

app.post('/api/retry', async (req, res) => {
  const { id_venda } = req.body as { id_venda?: string };
  if (!id_venda) {
    res.status(400).json({ erro: 'Campo obrigatorio: id_venda' });
    return;
  }

  const db = openDb(dbPath);
  if (!db) {
    res.status(503).json({ erro: 'Banco nao encontrado' });
    return;
  }

  try {
    const venda = db
      .prepare('SELECT id_venda, status, fila, fonte, produto FROM vendas WHERE id_venda = ?')
      .get(id_venda) as {
        id_venda: string;
        status: string;
        fila: string | null;
        fonte: string | null;
        produto: string | null;
      } | undefined;

    if (!venda) {
      res.status(404).json({ erro: 'Venda nao encontrada' });
      return;
    }

    if (venda.fonte === 'painel' || venda.produto === 'painel') {
      res.status(400).json({ erro: 'Venda do painel nao pode voltar para a fila' });
      return;
    }

    const resultado = recolocarVendaNaFila(id_venda, db);
    if (resultado.ok === false) {
      if (resultado.motivo === 'possui_nota') {
        res.status(409).json({ erro: 'Venda ja possui Nota; retry cancelado' });
        return;
      }
      if (resultado.motivo === 'sem_tentativa_rejeitada') {
        res.status(409).json({ erro: 'Venda em erro sem tentativa rejeitada; confira a SEFIN e concilie antes de tentar novamente' });
        return;
      }
      if (resultado.motivo === 'nao_esta_em_erro') {
        res.status(400).json({ erro: 'Venda nao esta em erro (status atual: ' + venda.status + ')' });
        return;
      }
      res.status(404).json({ erro: 'Venda nao encontrada' });
      return;
    }
  } finally {
    db.close();
  }

  res.json({ ok: true, mensagem: 'Venda voltou para fila. Use "Simular" para processar.' });
});

app.post('/api/emitir', async (req, res) => {
  if (!modoRealAtivo()) {
    res.status(409).json({ erro: 'Emissao real desabilitada no servidor' });
    return;
  }

  const pedido = req.body as Partial<EmissaoInput>;
  let ndpsDaEmissao: string | undefined;
  let idVendaEmissao: string | undefined;
  let falhaAoGravarTransicao = false;
  try {
    // Com emitirNfse injetado e sem deps.ambiente, a guarda não roda; o emissor real roda a sua.
    if (deps.ambiente !== undefined) {
      exigirLeiauteNovoPermitido(deps.ambiente, deps.agora);
    } else if (!deps.emitirNfse) {
      const { config: emissorConfig } = await import('./config.js');
      if (deps.agora === undefined) {
        exigirLeiauteNovoPermitido(emissorConfig.ambiente);
      } else {
        exigirLeiauteNovoPermitido(emissorConfig.ambiente, deps.agora);
      }
    }
    const exigirBundle = deps.exigirBundlePatchado
      ?? (await import('./emissor-preflight.js')).exigirBundlePatchado;
    exigirBundle();
    const pedidoValidado = {
      ...pedido,
      nDPS: '1',
    } as EmissaoInput;
    try {
      exigirEmissaoValida(pedidoValidado);
    } catch (err: unknown) {
      res.status(400).json({ erro: err instanceof Error ? err.message : 'Emissão inválida' });
      return;
    }
    const outputDirConfigurado = await resolverOutputDir();
    initDb(dbPath);
    let input = { ...pedidoValidado, nDPS: String(proximoNDPS(outputDirConfigurado)) };
    ndpsDaEmissao = input.nDPS;
    const outputDir = outputDirConfigurado ?? (await import('./emissor.js')).OUTPUT_DIR;
    const venda = {
      id_venda: `painel-${randomBytes(16).toString('hex')}`,
      fonte: 'painel',
      produto: 'painel',
      valor: input.vServ,
      data_venda: new Date().toISOString().slice(0, 10),
      cpf_cnpj: input.tomador.CNPJ ?? input.tomador.CPF,
      nome: input.tomador.xNome,
      ...(input.tomador.email ? { email: input.tomador.email } : {}),
      fila: 'pronta' as const,
      status: 'pronta' as const,
    };
    const tentativa = reservar(venda, outputDirConfigurado);
    if (!tentativa) {
      res.status(409).json({ erro: 'Venda não está disponível para emissão' });
      return;
    }
    idVendaEmissao = venda.id_venda;
    input = { ...input, nDPS: String(tentativa.ndps) };
    ndpsDaEmissao = input.nDPS;
    console.log('[server] Emitindo DPS ' + input.nDPS + ' para ' + input.tomador.xNome + '...');
    let emissor: (input: EmissaoInput) => Promise<unknown>;
    try {
      emissor = deps.emitirNfse ?? (await import('./emissor.js')).emitirNfse;
    } catch (err: unknown) {
      const detalhe = textoErroSefin(err) || 'erro não detalhado';
      throw new ErroAntesDoEnvio(`Falha ao carregar emissor antes do envio: ${detalhe}`, { cause: err });
    }
    const resultado = await emissor(input);
    const decisao = classificarRespostaEmissao(resultado);
    let chave: string | null = null;
    let erroChave: string | undefined;
    if (decisao.estado === 'autorizada') chave = decisao.chave;
    if (decisao.estado === 'sucesso_sem_chave') {
      try {
        chave = buscarChave(outputDir, input.nDPS);
      } catch (err: unknown) {
        const detalhe = textoErroSefin(err) || 'erro não detalhado';
        erroChave = `${MENSAGEM_CHAVE_A_VERIFICAR} Falha ao ler XML autorizado: ${detalhe}`;
        chave = null;
      }
    }
    const codigosSefin = decisao.estado === 'rejeitada'
      ? decisao.codigos
      : extrairCodigosSefin(resultado);
    if (decisao.estado === 'autorizada' && decisao.codigos.length > 0) {
      console.warn('[server] Avisos SEFIN (nota autorizada): ' + decisao.codigos.join(', '));
    }
    if (!chave) {
      if (decisao.estado === 'rejeitada') {
        try { marcarRejeitada(venda.id_venda, decisao.mensagem); } catch (secundario: unknown) {
          console.error(`[server] Falha ao marcar rejeição: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
          falhaAoGravarTransicao = true;
        }
      } else {
        try { marcarAveriguar(venda.id_venda, erroChave ?? MENSAGEM_CHAVE_A_VERIFICAR); } catch (secundario: unknown) {
          console.error(`[server] Falha ao marcar conciliação: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
          falhaAoGravarTransicao = true;
        }
      }
      const diagnostico = extrairDiagnosticoSefin(resultado, {
        codigos: codigosSefin,
        nDPS: input.nDPS,
      });
      console.error('[server] Resposta SEFIN:\n' + textoDiagnosticoSefin(
        diagnostico ?? { nDPS: input.nDPS },
      ));
    } else {
      concluirEmissao({
        chave_acesso: chave,
        ndps: Number(input.nDPS),
        id_venda: venda.id_venda,
        emitida_em: new Date().toISOString(),
      });
    }
    if (falhaAoGravarTransicao) {
      throw new Error(`Venda ${venda.id_venda} ficou para conferência; conciliação manual necessária.`);
    }
    res.json({
      autorizada: chave !== null,
      chaveAcesso: chave,
      ...(codigosSefin.length > 0 ? { codigosSefin } : {}),
    });
  } catch (err: unknown) {
    const diagnosticoSefin = extrairDiagnosticoSefin(err, {
      codigos: extrairCodigosSefin(err),
      nDPS: ndpsDaEmissao,
    });
    const textoErro = textoErroSefin(err, {
      codigos: extrairCodigosSefin(err),
      nDPS: ndpsDaEmissao,
    }) || 'Falha na emissão';
    if (idVendaEmissao && !falhaAoGravarTransicao) {
      try {
        if (ehErroAntesDoEnvio(err)) marcarRejeitada(idVendaEmissao, textoErro);
        else marcarAveriguar(idVendaEmissao, textoErro);
      } catch (secundario: unknown) {
        console.error(`[server] Falha ao marcar erro da emissão: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
        falhaAoGravarTransicao = true;
      }
    }
    if (falhaAoGravarTransicao) {
      res.status(500).json({
        erro: `Venda ${idVendaEmissao ?? '(desconhecida)'} ficou para conferência; conciliação manual necessária.`,
      });
      return;
    }
    if (err instanceof ConflitoEmissaoError) {
      res.status(409).json({ erro: err.message });
      return;
    }
    console.error('[server] Erro na emissao:\n' + mascararDocumentos(textoErro));
    const codigosSefin = [...new Set([
      ...(diagnosticoSefin?.codigo?.match(/\b[EA]\d{3,4}\b/gi) ?? []),
      ...extrairCodigosSefin(textoErro),
    ])];
    res.status(502).json({
      erro: 'Falha na emissao',
      ...(codigosSefin.length > 0 ? { codigosSefin } : {}),
    });
  }
});

  return app;
}

export const app = createPainelApp();

// Só sobe o listener quando executado diretamente (npx tsx server.ts) —
// importar o módulo em teste (para mascaraDoc) não deve abrir a porta 3000.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  initDb(DB_PATH);
  app.listen(PORT, '127.0.0.1', () => {
    console.log('Painel NFS-e (PRODUCAO REAL): http://localhost:' + PORT);
  });
}
