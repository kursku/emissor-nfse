/**
 * store.ts — SQLite persistence layer para o emissor NFS-e v2
 *
 * Usa node:sqlite (built-in Node 24, DatabaseSync).
 * Banco em: output/emissor.db (ao lado do codigo)
 *
 * API exportada:
 *   initDb()              — abre/cria banco, migrations, seed mapa_produtos
 *   upsertVenda(v)        — idempotente por id_venda
 *   listVendas(filtro?)   — lista vendas com filtro opcional
 *   proximoNDPS(outputDir) — próximo nDPS (MAX+1, seed via ndps.json)
 *   registrarNota(n)      — insere na tabela notas
 *   marcarStatus(id, s)   — atualiza fila/status/erro de uma venda
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mascararDocumentos } from './mascara.js';
import { chaveAcessoValida } from "./chave-acesso.js";
import { textoErroSefin } from './diagnostico-sefin.js';

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Estado do processamento de uma venda. */
export type StatusVenda =
  | "pendente"
  | "pronta"
  | "emitindo"
  | "simulada"
  | "emitida"
  | "a_verificar"
  | "erro"
  | "excecao"
  | "aguardando_garantia"
  | "pendente_cadastro"
  | "pronta_sem_endereco";

/** Fila em que a venda esta parada. */
export type FilaVenda =
  | "pronta"
  | "pendente_cadastro"
  | "aguardando_garantia"
  | "excecao"
  /** Tem documento e valor, mas falta endereco — a SEFIN recusa com E0234. */
  | "pronta_sem_endereco";

export interface Venda {
  id_venda: string;
  fonte?: string;
  contrato_id?: number;
  produto?: string;
  /** Valor da nota (comissão do coprodutor) */
  valor?: number;
  /** Valor bruto da venda (preço cheio pago pelo cliente) */
  valor_bruto?: number;
  data_venda?: string;
  /** Data de expiração da garantia (ISO AAAA-MM-DD) */
  data_expiracao?: string;
  /** Status original da Lastlink: Aprovada | Reembolsada | Expirada | Pendente */
  status_lastlink?: string;
  discriminacao?: string;
  cpf_cnpj?: string;
  nome?: string;
  email?: string;
  telefone?: string;
  cep?: string;
  /** Codigo IBGE do municipio do tomador, resolvido pelo CEP na importacao. */
  cmun?: string;
  cidade?: string;
  uf?: string;
  bairro?: string;
  rua?: string;
  numero?: string;
  complemento?: string;
  dias_garantia?: number;
  estrangeiro?: number; // 0 ou 1
  fila?: FilaVenda;
  status?: StatusVenda;
  erro?: string;
  criada_em?: string;
  atualizada_em?: string;
}

export interface NotaFiscal {
  chave_acesso: string;
  ndps: number;
  id_venda?: string;
  xml_path?: string;
  pdf_path?: string;
  emitida_em?: string;
}

export type EstadoTentativaEmissao = "reservada" | "rejeitada" | "a_verificar" | "concluida";

export interface TentativaEmissao {
  id: number;
  id_venda: string;
  ndps: number;
  estado: EstadoTentativaEmissao;
  chave_acesso?: string | null;
  criada_em: string;
  atualizada_em: string;
}

export interface NotaAssociacao {
  id_venda: string | null;
}

export type ResultadoRetryVenda =
  | { ok: true }
  | { ok: false; motivo: "nao_encontrada" | "possui_nota" | "nao_esta_em_erro" | "sem_tentativa_rejeitada" };

export class ConflitoEmissaoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflitoEmissaoError";
  }
}

export interface FiltroVendas {
  fila?: FilaVenda;
  status?: StatusVenda;
  id_venda?: string;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

function resolveDbPath(): string {
  const scriptDir = join(fileURLToPath(import.meta.url), "..");
  // Primeira execucao numa instalacao limpa: sem a pasta, o SQLite falha com
  // "unable to open database file" antes de qualquer mensagem util.
  mkdirSync(join(scriptDir, "output"), { recursive: true });
  return join(scriptDir, "output", "emissor.db");
}

// ─── initDb ──────────────────────────────────────────────────────────────────

/**
 * dbPath e so para teste (ex.: ':memory:'). Sem argumento, usa sempre
 * output/emissor.db e reaproveita a conexao entre chamadas — nao mude o
 * default em codigo de producao. Com dbPath explicito, SEMPRE abre uma
 * conexao nova (isolamento entre testes; ':memory:' reaberto e um banco
 * vazio novo, nao a mesma conexao anterior).
 */
export function initDb(dbPath?: string): DatabaseSync {
  const path = dbPath ?? resolveDbPath();
  const podeReaproveitar = dbPath === undefined && _db && _dbPath === path;
  if (podeReaproveitar) return _db as DatabaseSync;
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }

  const preflight = inspecionarBancoExistente(path);
  if (preflight.duplicatas.length > 0) {
    throw new Error(
      `Migração abortada: as Vendas ${preflight.duplicatas.join(', ')} têm mais de uma Nota. ` +
      'Resolva manualmente as duplicatas, mantendo no máximo uma Nota por Venda, e rode novamente.',
    );
  }
  if (preflight.precisaMigrar) criarBackup(path);

  _db = new DatabaseSync(path, { timeout: 5000 });
  _dbPath = path;

  try {
    _db.exec("PRAGMA journal_mode=WAL;");
    _db.exec("PRAGMA foreign_keys=ON;");

    _db.exec(`
    CREATE TABLE IF NOT EXISTS vendas (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      id_venda       TEXT    UNIQUE NOT NULL,
      fonte          TEXT,
      produto        TEXT,
      valor          REAL,
      data_venda     TEXT,
      discriminacao  TEXT,
      cpf_cnpj       TEXT,
      nome           TEXT,
      email          TEXT,
      telefone       TEXT,
      cep            TEXT,
      cidade         TEXT,
      uf             TEXT,
      bairro         TEXT,
      rua            TEXT,
      numero         TEXT,
      complemento    TEXT,
      dias_garantia  INTEGER,
      estrangeiro    INTEGER DEFAULT 0,
      fila           TEXT,
      status         TEXT,
      erro           TEXT,
      criada_em      TEXT,
      atualizada_em  TEXT
    );
    `);

    _db.exec(`
    CREATE TABLE IF NOT EXISTS notas (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_acesso TEXT UNIQUE NOT NULL,
      ndps         INTEGER NOT NULL,
      id_venda     TEXT REFERENCES vendas(id_venda),
      xml_path     TEXT,
      pdf_path     TEXT,
      emitida_em   TEXT
    );
    `);

    _db.exec(`
    CREATE TABLE IF NOT EXISTS mapa_produtos (
      produto    TEXT PRIMARY KEY,
      ctrib_nac  TEXT NOT NULL,
      cnbs       TEXT,
      xdesc_serv TEXT
    );
    `);

    // ── Migração idempotente: adiciona colunas novas se ainda não existirem ──────
    criarTabelaContratos();
    migrarSchema(_db);
    seedMapaProdutos();
    return _db;
  } catch (err) {
    _db.close();
    _db = null;
    _dbPath = null;
    throw err;
  }
}

function db(): DatabaseSync {
  if (!_db) throw new Error("DB não inicializado — chame initDb() antes.");
  return _db;
}

function exigirMudanca(changes: number | bigint, mensagem: string): void {
  if (Number(changes) !== 1) throw new Error(mensagem);
}

// ─── Migração de colunas ──────────────────────────────────────────────────────

/**
 * Adiciona as estruturas novas sem destruir dados existentes. A chamada é
 * idempotente: colunas, tabelas e índices usam a inspeção/DDL correspondente.
 */
export function detectarDuplicatasNotas(registros: NotaAssociacao[]): string[] {
  const contagem = new Map<string, number>();
  for (const registro of registros) {
    if (registro.id_venda === null) continue;
    contagem.set(registro.id_venda, (contagem.get(registro.id_venda) ?? 0) + 1);
  }
  return [...contagem.entries()]
    .filter(([, quantidade]) => quantidade > 1)
    .map(([idVenda]) => idVenda)
    .sort();
}

interface BancoExistente {
  precisaMigrar: boolean;
  duplicatas: string[];
}

function inspecionarBancoExistente(path: string): BancoExistente {
  if (path === ':memory:' || !existsSync(path)) {
    return { precisaMigrar: false, duplicatas: [] };
  }

  const existente = new DatabaseSync(path);
  try {
    const tabelas = new Set(
      (existente.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    if (!tabelas.has('vendas') && !tabelas.has('notas')) {
      return { precisaMigrar: false, duplicatas: [] };
    }

    const notas = tabelas.has('notas')
      ? existente.prepare('SELECT id_venda FROM notas WHERE id_venda IS NOT NULL').all() as unknown as NotaAssociacao[]
      : [];
    const colunasVendas = new Set(
      tabelas.has('vendas')
        ? (existente.prepare('PRAGMA table_info(vendas)').all() as Array<{ name: string }>).map((row) => row.name)
        : [],
    );
    const colunasContratos = new Set(
      tabelas.has('contratos')
        ? (existente.prepare('PRAGMA table_info(contratos)').all() as Array<{ name: string }>).map((row) => row.name)
        : [],
    );
    const indices = new Set(
      (existente.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const colunasVendasNecessarias = ['valor_bruto', 'status_lastlink', 'data_expiracao', 'cmun', 'contrato_id'];
    const colunasContratosNecessarias = [
      'cliente_cmun', 'cliente_cep', 'cliente_rua', 'cliente_numero',
      'cliente_complemento', 'cliente_bairro',
    ];
    const possuiBancoDoDominio = tabelas.has('vendas') || tabelas.has('notas');
    const precisaMigrar = possuiBancoDoDominio && (
      !tabelas.has('vendas') ||
      !tabelas.has('notas') ||
      !tabelas.has('mapa_produtos') ||
      !tabelas.has('contratos') ||
      !tabelas.has('tentativas_emissao') ||
      !indices.has('notas_id_venda_unico') ||
      !indices.has('tentativas_emissao_venda_aberta') ||
      !indices.has('idx_vendas_contrato_id') ||
      colunasVendasNecessarias.some((coluna) => !colunasVendas.has(coluna)) ||
      colunasContratosNecessarias.some((coluna) => !colunasContratos.has(coluna))
    );
    return { precisaMigrar, duplicatas: detectarDuplicatasNotas(notas) };
  } finally {
    existente.close();
  }
}

function criarBackup(path: string): void {
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
  let destino = `${path}.bak-${timestamp}`;
  let sufixo = 1;
  while (existsSync(destino)) {
    destino = `${path}.bak-${timestamp}-${sufixo++}`;
  }
  const banco = new DatabaseSync(path, { timeout: 5000 });
  try {
    const seguro = destino.replaceAll("'", "''");
    banco.exec(`VACUUM INTO '${seguro}'`);
  } finally {
    banco.close();
  }
}

function migrarSchema(database: DatabaseSync): void {
  const novasColunas: Array<{ tabela: string; nome: string; ddl: string }> = [
    { tabela: "vendas", nome: "valor_bruto",           ddl: "ALTER TABLE vendas ADD COLUMN valor_bruto REAL" },
    { tabela: "vendas", nome: "status_lastlink",       ddl: "ALTER TABLE vendas ADD COLUMN status_lastlink TEXT" },
    { tabela: "vendas", nome: "data_expiracao",        ddl: "ALTER TABLE vendas ADD COLUMN data_expiracao TEXT" },
    { tabela: "vendas", nome: "cmun",                  ddl: "ALTER TABLE vendas ADD COLUMN cmun TEXT" },
    { tabela: "vendas", nome: "contrato_id",           ddl: "ALTER TABLE vendas ADD COLUMN contrato_id INTEGER NULL REFERENCES contratos(id) DEFAULT NULL" },
    { tabela: "contratos", nome: "cliente_cmun",       ddl: "ALTER TABLE contratos ADD COLUMN cliente_cmun TEXT" },
    { tabela: "contratos", nome: "cliente_cep",        ddl: "ALTER TABLE contratos ADD COLUMN cliente_cep TEXT" },
    { tabela: "contratos", nome: "cliente_rua",        ddl: "ALTER TABLE contratos ADD COLUMN cliente_rua TEXT" },
    { tabela: "contratos", nome: "cliente_numero",     ddl: "ALTER TABLE contratos ADD COLUMN cliente_numero TEXT" },
    { tabela: "contratos", nome: "cliente_complemento", ddl: "ALTER TABLE contratos ADD COLUMN cliente_complemento TEXT" },
    { tabela: "contratos", nome: "cliente_bairro",     ddl: "ALTER TABLE contratos ADD COLUMN cliente_bairro TEXT" },
  ];
  const colunasTicket9 = new Set([
    "vendas.contrato_id",
    "contratos.cliente_cmun",
    "contratos.cliente_cep",
    "contratos.cliente_rua",
    "contratos.cliente_numero",
    "contratos.cliente_complemento",
    "contratos.cliente_bairro",
  ]);

  database.exec('BEGIN IMMEDIATE');
  try {
    let migrouTicket9 = false;
    for (const col of novasColunas) {
      const existentes = new Set(
        (database.prepare(`PRAGMA table_info(${col.tabela})`).all() as Array<{ name: string }>)
          .map((c) => c.name),
      );
      if (!existentes.has(col.nome)) {
        database.exec(col.ddl);
        if (colunasTicket9.has(`${col.tabela}.${col.nome}`)) migrouTicket9 = true;
      }
    }

    database.exec("CREATE INDEX IF NOT EXISTS idx_vendas_contrato_id ON vendas(contrato_id)");

    database.exec(`
      CREATE TABLE IF NOT EXISTS tentativas_emissao (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        id_venda       TEXT NOT NULL REFERENCES vendas(id_venda),
        ndps           INTEGER NOT NULL UNIQUE,
        estado         TEXT NOT NULL CHECK (estado IN ('reservada', 'rejeitada', 'a_verificar', 'concluida')),
        chave_acesso   TEXT UNIQUE,
        criada_em      TEXT NOT NULL,
        atualizada_em  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notas_id_venda_unico
        ON notas(id_venda) WHERE id_venda IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS tentativas_emissao_venda_aberta
        ON tentativas_emissao(id_venda)
        WHERE estado IN ('reservada', 'a_verificar');
    `);

    if (migrouTicket9) {
      const vendasLegadas = database.prepare(`
        SELECT id_venda
        FROM vendas
        WHERE id_venda LIKE 'contrato-%'
          AND fonte = 'contrato'
          AND COALESCE(status, '') NOT IN ('emitida', 'emitindo', 'a_verificar', 'simulada')
          AND NOT EXISTS (
            SELECT 1 FROM notas WHERE notas.id_venda = vendas.id_venda
          )
      `).all() as unknown as Array<{ id_venda: string }>;
      const buscarContrato = database.prepare(`
        SELECT cliente_cmun, cliente_cep, cliente_rua, cliente_numero,
               cliente_complemento, cliente_bairro
        FROM contratos WHERE id = ?
      `);
      const preencherVendaLegada = database.prepare(`
        UPDATE vendas
        SET contrato_id = COALESCE(contrato_id, ?),
            cmun = COALESCE(cmun, ?),
            cep = COALESCE(cep, ?),
            rua = COALESCE(rua, ?),
            numero = COALESCE(numero, ?),
            complemento = COALESCE(complemento, ?),
            bairro = COALESCE(bairro, ?)
        WHERE id_venda = ?
          AND fonte = 'contrato'
          AND COALESCE(status, '') NOT IN ('emitida', 'emitindo', 'a_verificar', 'simulada')
          AND NOT EXISTS (
            SELECT 1 FROM notas WHERE notas.id_venda = vendas.id_venda
          )
      `);
      for (const venda of vendasLegadas) {
        const match = /^contrato-(\d+)-\d{4}-\d{2}$/.exec(venda.id_venda);
        if (!match) continue;
        const contratoId = Number(match[1]);
        const contrato = buscarContrato.get(contratoId) as unknown as {
          cliente_cmun: string | null;
          cliente_cep: string | null;
          cliente_rua: string | null;
          cliente_numero: string | null;
          cliente_complemento: string | null;
          cliente_bairro: string | null;
        } | undefined;
        if (!contrato) continue;
        preencherVendaLegada.run(
          contratoId,
          contrato.cliente_cmun,
          contrato.cliente_cep,
          contrato.cliente_rua,
          contrato.cliente_numero,
          contrato.cliente_complemento,
          contrato.cliente_bairro,
          venda.id_venda,
        );
      }
    }
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer migração: ${textoErroSefin(rollbackError) || 'erro não detalhado'}`);
    }
    throw err;
  }
}

// ─── Seed mapa_produtos ───────────────────────────────────────────────────────

// Mapa produto -> codigos fiscais, usado pela importacao de vendas: o nome do
// produto na planilha precisa bater exatamente com a chave aqui. Vazio de
// proposito — cadastre os seus servicos, com os codigos que o contador
// confirmar (cTribNac = item da LC 116; cNBS = Nomenclatura Brasileira de
// Servicos), pelo painel ou por INSERT direto em mapa_produtos.
const SEED_PRODUTOS: Array<{
  produto: string;
  ctrib_nac: string;
  cnbs: string;
  xdesc_serv: string;
}> = [];

function seedMapaProdutos(): void {
  const stmt = db().prepare(`
    INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(produto) DO NOTHING
  `);
  for (const p of SEED_PRODUTOS) {
    stmt.run(p.produto, p.ctrib_nac, p.cnbs, p.xdesc_serv);
  }
}

// ─── upsertVenda ─────────────────────────────────────────────────────────────

/**
 * Idempotente por id_venda.
 * No conflito, atualiza dados cadastrais mas NUNCA regride fila/status
 * se já for 'emitida' ou 'simulada'.
 */
export function upsertVenda(v: Venda): void {
  const now = new Date().toISOString();

  db().prepare(`
    INSERT INTO vendas
      (id_venda, fonte, contrato_id, produto, valor, valor_bruto, data_venda, data_expiracao,
       status_lastlink, discriminacao,
       cpf_cnpj, nome, email, telefone, cep, cmun, cidade, uf, bairro,
       rua, numero, complemento, dias_garantia, estrangeiro,
       fila, status, erro, criada_em, atualizada_em)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_venda) DO UPDATE SET
      fonte           = excluded.fonte,
      contrato_id     = COALESCE(excluded.contrato_id, vendas.contrato_id),
      produto         = excluded.produto,
      valor           = excluded.valor,
      valor_bruto     = excluded.valor_bruto,
      data_venda      = excluded.data_venda,
      data_expiracao  = excluded.data_expiracao,
      status_lastlink = excluded.status_lastlink,
      discriminacao   = excluded.discriminacao,
      cpf_cnpj        = excluded.cpf_cnpj,
      nome            = excluded.nome,
      email           = excluded.email,
      telefone        = excluded.telefone,
      cep             = excluded.cep,
      cmun            = excluded.cmun,
      cidade          = excluded.cidade,
      uf              = excluded.uf,
      bairro          = excluded.bairro,
      rua             = excluded.rua,
      numero          = excluded.numero,
      complemento     = excluded.complemento,
      dias_garantia   = excluded.dias_garantia,
      estrangeiro     = excluded.estrangeiro,
      fila = CASE
        WHEN vendas.status IN ('emitida', 'simulada', 'emitindo', 'a_verificar', 'erro') THEN vendas.fila
        ELSE excluded.fila
      END,
      status = CASE
        WHEN vendas.status IN ('emitida', 'simulada', 'emitindo', 'a_verificar', 'erro') THEN vendas.status
        ELSE excluded.status
      END,
      erro = CASE
        WHEN excluded.status = 'a_verificar' THEN excluded.erro
        ELSE vendas.erro
      END,
      atualizada_em = ?
  `).run(
    v.id_venda,
    v.fonte ?? null,
    v.contrato_id ?? null,
    v.produto ?? null,
    v.valor ?? null,
    v.valor_bruto ?? null,
    v.data_venda ?? null,
    v.data_expiracao ?? null,
    v.status_lastlink ?? null,
    v.discriminacao ?? null,
    v.cpf_cnpj ?? null,
    v.nome ?? null,
    v.email ?? null,
    v.telefone ?? null,
    v.cep ?? null,
    v.cmun ?? null,
    v.cidade ?? null,
    v.uf ?? null,
    v.bairro ?? null,
    v.rua ?? null,
    v.numero ?? null,
    v.complemento ?? null,
    v.dias_garantia ?? null,
    v.estrangeiro ?? 0,
    v.fila ?? null,
    v.status ?? null,
    v.erro ?? null,
    now, // criada_em — ignorado no UPDATE
    now, // atualizada_em — usado no UPDATE SET
  );
}

// ─── listVendas ───────────────────────────────────────────────────────────────

export function listVendas(filtro?: FiltroVendas): Venda[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filtro?.fila) {
    conditions.push("fila = ?");
    params.push(filtro.fila);
  }
  if (filtro?.status) {
    conditions.push("status = ?");
    params.push(filtro.status);
  }
  if (filtro?.id_venda) {
    conditions.push("id_venda = ?");
    params.push(filtro.id_venda);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db()
    .prepare(`SELECT * FROM vendas ${where} ORDER BY data_venda DESC`)
    .all(...params) as unknown as Venda[];
}

// ─── proximoNDPS ─────────────────────────────────────────────────────────────

/**
 * Retorna um nDPS acima de todas as fontes locais conhecidas, incluindo os
 * arquivos de resultado e o piso do contador legado.
 */
export function proximoNDPS(outputDir?: string): number {
  return proximoNDPSNoBanco(db(), outputDir);
}

function resolverPastaSaida(outputDir?: string): string {
  return outputDir?.trim()
    || process.env['NFSE_OUTPUT_DIR']?.trim()
    || join(fileURLToPath(import.meta.url), "..", "output", "nfewizard");
}

function proximoNDPSNoBanco(database: DatabaseSync, outputDir?: string): number {
  const row = database
    .prepare(`
      SELECT
        (SELECT MAX(ndps) FROM notas) AS maxNota,
        (SELECT MAX(ndps) FROM tentativas_emissao) AS maxTentativa
    `)
    .get() as { maxNota: number | null; maxTentativa: number | null } | null;

  let maior = Math.max(row?.maxNota ?? 0, row?.maxTentativa ?? 0);

  const pastaSaida = resolverPastaSaida(outputDir);
  const ndpsPath = join(pastaSaida, "ndps.json");
  let conteudoPiso: string | undefined;
  try {
    conteudoPiso = readFileSync(ndpsPath, "utf-8");
  } catch (erro: unknown) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") conteudoPiso = undefined;
    else throw erro;
  }
  if (conteudoPiso !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(conteudoPiso);
    } catch (erro: unknown) {
      throw new Error(`[store] Piso nDPS inválido em ${ndpsPath}: JSON quebrado.`, { cause: erro });
    }
    const proximo = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { proximoNDPS?: unknown }).proximoNDPS
      : undefined;
    if (!ehNdpsSeguro(proximo)) {
      throw new Error(`[store] Piso nDPS inválido em ${ndpsPath}: proximoNDPS deve ser inteiro positivo seguro.`);
    }
    maior = Math.max(maior, proximo - 1);
  }

  try {
    for (const nome of readdirSync(pastaSaida)) {
      const ndpsTexto = /^resultado-ndps-(\d+)\.json$/i.exec(nome)?.[1];
      if (!ndpsTexto) continue;
      const ndps = Number(ndpsTexto);
      if (ehNdpsSeguro(ndps)) {
        maior = Math.max(maior, ndps);
      } else {
        throw new Error(`[store] nDPS inválido no arquivo ${join(pastaSaida, nome)}.`);
      }
    }
  } catch (erro: unknown) {
    if ((erro as NodeJS.ErrnoException).code !== "ENOENT") throw erro;
  }

  return Math.max(1, maior + 1);
}

function ehNdpsSeguro(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0;
}

export function buscarNotaPorVenda(idVenda: string): NotaFiscal | null {
  return buscarNotaPorVendaNoBanco(db(), idVenda);
}

function buscarNotaPorVendaNoBanco(database: DatabaseSync, idVenda: string): NotaFiscal | null {
  const nota = database
    .prepare('SELECT chave_acesso, ndps, id_venda, xml_path, pdf_path, emitida_em FROM notas WHERE id_venda = ?')
    .get(idVenda) as unknown as NotaFiscal | undefined;
  return nota ?? null;
}

function erroUnicoNdps(err: unknown): boolean {
  return String(err).includes('UNIQUE constraint failed: tentativas_emissao.ndps');
}

export function reservarEmissao(idVenda: string, outputDir?: string): TentativaEmissao | null {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const database = db();
    database.exec('BEGIN IMMEDIATE');
    try {
      const reserva = reservarEmissaoNaTransacao(database, idVenda, outputDir);
      database.exec('COMMIT');
      return reserva;
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch (rollbackError) {
        console.error(`[store] Falha ao desfazer reserva: ${String(rollbackError)}`);
      }
      if (erroUnicoNdps(err) && tentativa < 2) continue;
      throw err;
    }
  }
  return null;
}

function reservarEmissaoNaTransacao(
  database: DatabaseSync,
  idVenda: string,
  outputDir?: string,
): TentativaEmissao | null {
  if (buscarNotaPorVendaNoBanco(database, idVenda)) return null;

  const venda = database
    .prepare('SELECT status, fila FROM vendas WHERE id_venda = ?')
    .get(idVenda) as { status: string | null; fila: string | null } | undefined;
  if (!venda || venda.fila !== 'pronta' || (venda.status !== null && venda.status !== 'pronta')) return null;

  const aberta = database
    .prepare("SELECT id FROM tentativas_emissao WHERE id_venda = ? AND estado IN ('reservada', 'a_verificar')")
    .get(idVenda) as { id: number } | undefined;
  if (aberta) return null;

  const agora = new Date().toISOString();
  const ndps = proximoNDPSNoBanco(database, outputDir);
  database.prepare(`
    INSERT INTO tentativas_emissao
      (id_venda, ndps, estado, criada_em, atualizada_em)
    VALUES (?, ?, 'reservada', ?, ?)
  `).run(idVenda, ndps, agora, agora);
  const vendaAtualizada = database.prepare(`
    UPDATE vendas
    SET status = 'emitindo', fila = NULL, erro = NULL, atualizada_em = ?
    WHERE id_venda = ?
  `).run(agora, idVenda);
  exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${idVenda} para emitindo não foi aplicada.`);

  return database
    .prepare('SELECT id, id_venda, ndps, estado, chave_acesso, criada_em, atualizada_em FROM tentativas_emissao WHERE id_venda = ? AND ndps = ?')
    .get(idVenda, ndps) as unknown as TentativaEmissao;
}

export function criarEReservarEmissao(venda: Venda, outputDir?: string): TentativaEmissao | null {
  const database = db();
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    database.exec('BEGIN IMMEDIATE');
    try {
      upsertVenda(venda);
      const reserva = reservarEmissaoNaTransacao(database, venda.id_venda, outputDir);
      database.exec('COMMIT');
      return reserva;
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch (rollbackError) {
        console.error(`[store] Falha ao desfazer criação da Venda: ${String(rollbackError)}`);
      }
      if (erroUnicoNdps(err) && tentativa < 2) continue;
      throw err;
    }
  }
  return null;
}

export function marcarTentativaAveriguar(idVenda: string, erro: string): void {
  const database = db();
  const agora = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const tentativaAtualizada = database.prepare(`
      UPDATE tentativas_emissao
      SET estado = 'a_verificar', atualizada_em = ?
      WHERE id_venda = ? AND estado = 'reservada'
    `).run(agora, idVenda);
    exigirMudanca(tentativaAtualizada.changes, `Transição da tentativa da Venda ${idVenda} para a verificar não foi aplicada.`);
    const vendaAtualizada = database.prepare(`
      UPDATE vendas
      SET status = 'a_verificar', fila = NULL, erro = ?, atualizada_em = ?
      WHERE id_venda = ? AND status = 'emitindo'
    `).run(mascararDocumentos(erro), agora, idVenda);
    exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${idVenda} para a verificar não foi aplicada.`);
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer marcação a verificar: ${String(rollbackError)}`);
    }
    throw err;
  }
}

export function marcarTentativaRejeitada(idVenda: string, erro: string): void {
  const database = db();
  const agora = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const tentativaAtualizada = database.prepare(`
      UPDATE tentativas_emissao
      SET estado = 'rejeitada', atualizada_em = ?
      WHERE id_venda = ? AND estado = 'reservada'
    `).run(agora, idVenda);
    exigirMudanca(tentativaAtualizada.changes, `Transição da tentativa da Venda ${idVenda} para rejeitada não foi aplicada.`);
    const vendaAtualizada = database.prepare(`
      UPDATE vendas
      SET status = 'erro', fila = NULL, erro = ?, atualizada_em = ?
      WHERE id_venda = ? AND status = 'emitindo'
    `).run(mascararDocumentos(erro), agora, idVenda);
    exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${idVenda} para erro não foi aplicada.`);
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer rejeição: ${String(rollbackError)}`);
    }
    throw err;
  }
}

export function concluirEmissao(nota: NotaFiscal): void {
  if (!nota.id_venda) throw new Error('Emissão exige id_venda.');
  if (!chaveAcessoValida(nota.chave_acesso)) {
    throw new Error("Nota exige uma Chave de acesso válida de 50 dígitos.");
  }

  const database = db();
  const agora = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const tentativa = database
      .prepare('SELECT id, id_venda, ndps, estado, chave_acesso FROM tentativas_emissao WHERE id_venda = ? AND ndps = ?')
      .get(nota.id_venda, nota.ndps) as {
        id: number;
        id_venda: string;
        ndps: number;
        estado: EstadoTentativaEmissao;
        chave_acesso: string | null;
      } | undefined;

    if (!tentativa) {
      const tentativaDaVenda = database
        .prepare('SELECT ndps FROM tentativas_emissao WHERE id_venda = ? ORDER BY id DESC LIMIT 1')
        .get(nota.id_venda) as { ndps: number } | undefined;
      if (tentativaDaVenda) {
        throw new ConflitoEmissaoError(
          `Conflito de Nota para a Venda ${nota.id_venda}: tentativa reservada com nDPS ${tentativaDaVenda.ndps}, não ${nota.ndps}.`,
        );
      }

      const tentativaDeOutraVenda = database
        .prepare('SELECT id_venda FROM tentativas_emissao WHERE ndps = ? LIMIT 1')
        .get(nota.ndps) as { id_venda: string } | undefined;
      if (tentativaDeOutraVenda) {
        throw new ConflitoEmissaoError(
          `Conflito de Nota: o nDPS ${nota.ndps} pertence à Venda ${tentativaDeOutraVenda.id_venda}.`,
        );
      }
      throw new ConflitoEmissaoError(
        `Conflito de Nota: não existe tentativa da Venda ${nota.id_venda} para o nDPS ${nota.ndps}.`,
      );
    }

    if (tentativa.estado === 'rejeitada') {
      throw new ConflitoEmissaoError(
        `Conflito de Nota: a tentativa da Venda ${nota.id_venda} já foi rejeitada.`,
      );
    }
    if (tentativa.estado === 'concluida' && tentativa.chave_acesso !== nota.chave_acesso) {
      throw new ConflitoEmissaoError(
        `Conflito de Nota para a Venda ${nota.id_venda}: tentativa concluída com outra Chave.`,
      );
    }

    finalizarEmissaoNaTransacao(database, nota, tentativa.id, agora);
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer finalização: ${String(rollbackError)}`);
    }
    if (String(err).includes('UNIQUE constraint failed: notas.') ||
        String(err).includes('UNIQUE constraint failed: tentativas_emissao.chave_acesso')) {
      throw new ConflitoEmissaoError(`Conflito de Nota para a Venda ${nota.id_venda}.`);
    }
    throw err;
  }
}

function finalizarEmissaoNaTransacao(
  database: DatabaseSync,
  nota: NotaFiscal,
  idTentativa: number | undefined,
  agora: string,
): void {
  const existente = buscarNotaPorVendaNoBanco(database, nota.id_venda as string);
  if (existente) {
    if (existente.chave_acesso !== nota.chave_acesso || existente.ndps !== nota.ndps) {
      throw new ConflitoEmissaoError(
        `Conflito de Nota para a Venda ${nota.id_venda}: já existe outra Chave ou nDPS.`,
      );
    }
  } else {
    const chaveUsada = database
      .prepare('SELECT id_venda FROM notas WHERE chave_acesso = ?')
      .get(nota.chave_acesso) as { id_venda: string | null } | undefined;
    if (chaveUsada) {
      throw new ConflitoEmissaoError(
        `Conflito de Nota: a Chave de acesso já está ligada à Venda ${chaveUsada.id_venda ?? '(sem Venda)'}.`,
      );
    }
    const ndpsUsado = database
      .prepare('SELECT id_venda FROM notas WHERE ndps = ?')
      .get(nota.ndps) as { id_venda: string | null } | undefined;
    if (ndpsUsado) {
      throw new ConflitoEmissaoError(
        `Conflito de Nota: o nDPS ${nota.ndps} já está ligado à Venda ${ndpsUsado.id_venda ?? '(sem Venda)'}.`,
      );
    }
    database.prepare(`
      INSERT INTO notas (chave_acesso, ndps, id_venda, xml_path, pdf_path, emitida_em)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      nota.chave_acesso,
      nota.ndps,
      nota.id_venda,
      nota.xml_path ?? null,
      nota.pdf_path ?? null,
      nota.emitida_em ?? agora,
    );
  }

  if (idTentativa !== undefined) {
    const tentativaAtualizada = database.prepare(`
      UPDATE tentativas_emissao
      SET estado = 'concluida', chave_acesso = ?, atualizada_em = ?
      WHERE id = ?
    `).run(nota.chave_acesso, agora, idTentativa);
    exigirMudanca(tentativaAtualizada.changes, `Transição da tentativa da Venda ${nota.id_venda} para concluída não foi aplicada.`);
  }
  const vendaAtualizada = database.prepare(`
    UPDATE vendas
    SET status = 'emitida', fila = 'pronta', erro = NULL, atualizada_em = ?
    WHERE id_venda = ?
  `).run(agora, nota.id_venda);
  exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${nota.id_venda} para emitida não foi aplicada.`);
}

export function listarReservasAbandonadas(
  agora = new Date(),
  avisar: (mensagem: string) => void = (mensagem) => console.warn(mensagem),
): string[] {
  const database = db();
  const limite = new Date(agora.getTime() - 10 * 60 * 1000).toISOString();
  const atualizadaEm = agora.toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const reservas = database.prepare(`
      SELECT id, id_venda
      FROM tentativas_emissao
      WHERE estado = 'reservada' AND atualizada_em < ?
      ORDER BY id
    `).all(limite) as Array<{ id: number; id_venda: string }>;
    const ids: string[] = [];
    for (const reserva of reservas) {
      const mensagem = 'Reserva de emissão abandonada; conciliação manual necessária.';
      const tentativaAtualizada = database.prepare(`
        UPDATE tentativas_emissao
        SET estado = 'a_verificar', atualizada_em = ?
        WHERE id = ? AND estado = 'reservada'
      `).run(atualizadaEm, reserva.id);
      exigirMudanca(tentativaAtualizada.changes, `Transição da tentativa da Venda ${reserva.id_venda} para a verificar não foi aplicada.`);
      const vendaAtualizada = database.prepare(`
        UPDATE vendas
        SET status = 'a_verificar', fila = NULL, erro = ?, atualizada_em = ?
        WHERE id_venda = ? AND status = 'emitindo'
      `).run(mascararDocumentos(mensagem), atualizadaEm, reserva.id_venda);
      exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${reserva.id_venda} para a verificar não foi aplicada.`);
      ids.push(reserva.id_venda);
      avisar(`Reserva abandonada para a Venda ${reserva.id_venda}; marcada a verificar.`);
    }
    database.exec('COMMIT');
    return ids;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer recuperação de reservas: ${String(rollbackError)}`);
    }
    throw err;
  }
}

export function recolocarVendaNaFila(idVenda: string, banco?: DatabaseSync): ResultadoRetryVenda {
  const database = banco ?? db();
  database.exec('BEGIN IMMEDIATE');
  try {
    if (buscarNotaPorVendaNoBanco(database, idVenda)) {
      database.exec('COMMIT');
      return { ok: false, motivo: 'possui_nota' };
    }
    const venda = database.prepare('SELECT status, fila FROM vendas WHERE id_venda = ?').get(idVenda) as {
      status: string | null;
      fila: string | null;
    } | undefined;
    if (!venda) {
      database.exec('COMMIT');
      return { ok: false, motivo: 'nao_encontrada' };
    }
    const erroPreEnvio = venda.status === 'excecao' && venda.fila === 'excecao';
    if (venda.status !== 'erro' && !erroPreEnvio) {
      database.exec('COMMIT');
      return { ok: false, motivo: 'nao_esta_em_erro' };
    }
    if (!erroPreEnvio) {
      const ultima = database.prepare(`
        SELECT estado FROM tentativas_emissao
        WHERE id_venda = ? ORDER BY id DESC LIMIT 1
      `).get(idVenda) as { estado: EstadoTentativaEmissao } | undefined;
      if (ultima?.estado !== 'rejeitada') {
        database.exec('COMMIT');
        return { ok: false, motivo: 'sem_tentativa_rejeitada' };
      }
    }
    const agora = new Date().toISOString();
    const vendaAtualizada = database.prepare(`
      UPDATE vendas
      SET status = 'pronta', fila = 'pronta', erro = NULL, atualizada_em = ?
      WHERE id_venda = ? AND (status = 'erro' OR (status = 'excecao' AND fila = 'excecao'))
    `).run(agora, idVenda);
    exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${idVenda} para pronta não foi aplicada.`);
    database.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer retry da Venda: ${String(rollbackError)}`);
    }
    throw err;
  }
}

export function conciliarComChave(idVenda: string, chaveAcesso: string): void {
  if (!chaveAcessoValida(chaveAcesso)) throw new Error('Conciliação exige uma Chave de acesso válida de 50 dígitos.');
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const venda = database.prepare('SELECT status FROM vendas WHERE id_venda = ?').get(idVenda) as {
      status: string | null;
    } | undefined;
    const tentativa = database.prepare(
      "SELECT id, ndps, estado FROM tentativas_emissao WHERE id_venda = ? AND estado IN ('a_verificar', 'reservada') ORDER BY id DESC LIMIT 1",
    ).get(idVenda) as { id: number; ndps: number; estado: EstadoTentativaEmissao } | undefined;
    const reservaPendente = venda?.status === 'emitindo' && tentativa?.estado === 'reservada';
    const aVerificar = venda?.status === 'a_verificar' && tentativa?.estado === 'a_verificar';
    if ((!aVerificar && !reservaPendente) || !tentativa) {
      throw new Error(`Venda ${idVenda} não está a verificar.`);
    }
    if (reservaPendente) {
      console.warn(`Aviso: a Venda ${idVenda} ainda está reservada; o operador declara o resultado conferido na SEFIN.`);
    }
    finalizarEmissaoNaTransacao(database, {
      id_venda: idVenda,
      ndps: tentativa.ndps,
      chave_acesso: chaveAcesso,
    }, tentativa.id, new Date().toISOString());
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer conciliação com Chave: ${String(rollbackError)}`);
    }
    throw err;
  }
}

export function conciliarRejeitada(idVenda: string): void {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const venda = database.prepare('SELECT status FROM vendas WHERE id_venda = ?').get(idVenda) as {
      status: string | null;
    } | undefined;
    const tentativa = database.prepare(
      "SELECT id, estado FROM tentativas_emissao WHERE id_venda = ? AND estado IN ('a_verificar', 'reservada') ORDER BY id DESC LIMIT 1",
    ).get(idVenda) as { id: number; estado: EstadoTentativaEmissao } | undefined;
    const reservaPendente = venda?.status === 'emitindo' && tentativa?.estado === 'reservada';
    const aVerificar = venda?.status === 'a_verificar' && tentativa?.estado === 'a_verificar';
    if ((!aVerificar && !reservaPendente) || !tentativa) {
      throw new Error(`Venda ${idVenda} não está a verificar.`);
    }
    if (reservaPendente) {
      console.warn(`Aviso: a Venda ${idVenda} ainda está reservada; o operador declara o resultado conferido na SEFIN.`);
    }
    const statusEsperado = reservaPendente ? 'emitindo' : 'a_verificar';
    const agora = new Date().toISOString();
    const tentativaAtualizada = database.prepare(`
      UPDATE tentativas_emissao
      SET estado = 'rejeitada', atualizada_em = ?
      WHERE id = ?
    `).run(agora, tentativa.id);
    exigirMudanca(tentativaAtualizada.changes, `Transição da tentativa da Venda ${idVenda} para rejeitada não foi aplicada.`);
    const vendaAtualizada = database.prepare(`
      UPDATE vendas
      SET status = 'erro', fila = NULL, erro = ?, atualizada_em = ?
      WHERE id_venda = ? AND status = ?
    `).run('Conciliação: emissão rejeitada pela SEFIN.', agora, idVenda, statusEsperado);
    exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${idVenda} para erro não foi aplicada.`);
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (rollbackError) {
      console.error(`[store] Falha ao desfazer conciliação rejeitada: ${String(rollbackError)}`);
    }
    throw err;
  }
}

// ─── registrarNota ────────────────────────────────────────────────────────────

export function registrarNota(n: NotaFiscal): void {
  if (!chaveAcessoValida(n.chave_acesso)) {
    throw new Error("Nota exige uma Chave de acesso válida de 50 dígitos.");
  }

  const now = new Date().toISOString();
  db()
    .prepare(`
      INSERT INTO notas (chave_acesso, ndps, id_venda, xml_path, pdf_path, emitida_em)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chave_acesso) DO NOTHING
    `)
    .run(
      n.chave_acesso,
      n.ndps,
      n.id_venda ?? null,
      n.xml_path ?? null,
      n.pdf_path ?? null,
      n.emitida_em ?? now,
    );
}

// ─── Contratos recorrentes ───────────────────────────────────────────────────

export interface Contrato {
  id?: number;
  cliente_doc: string;
  cliente_nome: string;
  cliente_email?: string;
  cliente_cmun: string;
  cliente_cep: string;
  cliente_rua: string;
  cliente_numero: string;
  cliente_complemento?: string;
  cliente_bairro: string;
  valor: number;
  xdesc_serv: string;
  ctrib_nac: string;
  cnbs: string;
  dia_do_mes: number;
  ativo?: number;
  criado_em?: string;
}

/**
 * Garante que a tabela contratos existe (chamado em initDb).
 * Seguro chamar múltiplas vezes (CREATE TABLE IF NOT EXISTS).
 */
export function criarTabelaContratos(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS contratos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_doc  TEXT    NOT NULL,
      cliente_nome TEXT    NOT NULL,
      cliente_email TEXT,
      valor        REAL    NOT NULL,
      xdesc_serv   TEXT    NOT NULL,
      ctrib_nac    TEXT    NOT NULL,
      cnbs         TEXT,
      cliente_cmun TEXT,
      cliente_cep  TEXT,
      cliente_rua  TEXT,
      cliente_numero TEXT,
      cliente_complemento TEXT,
      cliente_bairro TEXT,
      dia_do_mes   INTEGER NOT NULL,
      ativo        INTEGER DEFAULT 1,
      criado_em    TEXT
    );
  `);
}

type DadosEnderecoContrato = Pick<Contrato,
  "cliente_cmun" | "cliente_cep" | "cliente_rua" | "cliente_numero" |
  "cliente_complemento" | "cliente_bairro" | "cnbs"
>;

function camposContratoAusentes(c: DadosEnderecoContrato): string[] {
  const faltantes: string[] = [];
  for (const [nome, valor] of [
    ["cliente_cmun", c.cliente_cmun],
    ["cliente_cep", c.cliente_cep],
    ["cliente_rua", c.cliente_rua],
    ["cliente_numero", c.cliente_numero],
    ["cliente_bairro", c.cliente_bairro],
  ] as Array<[string, string | undefined]>) {
    if (!valor?.trim()) faltantes.push(nome);
  }
  if (!c.cnbs?.trim()) faltantes.push("cNBS");
  return faltantes;
}

/** Cria um novo contrato recorrente com dados fiscais e endereço completos. */
export function criarContrato(c: Omit<Contrato, "id" | "criado_em">): number {
  const faltantes = camposContratoAusentes(c);
  if (faltantes.length > 0) {
    throw new Error(`Contrato ${c.cliente_nome || "sem nome"} inválido: faltam ${faltantes.join(", ")}.`);
  }

  const now = new Date().toISOString();
  const result = db()
    .prepare(`
      INSERT INTO contratos
        (cliente_doc, cliente_nome, cliente_email, valor, xdesc_serv,
         ctrib_nac, cnbs, cliente_cmun, cliente_cep, cliente_rua,
         cliente_numero, cliente_complemento, cliente_bairro, dia_do_mes,
         ativo, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)
    .run(
      c.cliente_doc,
      c.cliente_nome,
      c.cliente_email ?? null,
      c.valor,
      c.xdesc_serv,
      c.ctrib_nac,
      c.cnbs,
      c.cliente_cmun,
      c.cliente_cep,
      c.cliente_rua,
      c.cliente_numero,
      c.cliente_complemento ?? null,
      c.cliente_bairro,
      c.dia_do_mes,
      now,
    );

  const id = result.lastInsertRowid as number;

  // Registra o produto no mapa_produtos para que fila.ts consiga mapear os campos fiscais.
  // Chave: "Contrato: <desc>" — mesmo valor usado em gerarVendasDoMes.
  const produtoChave = `Contrato: ${c.xdesc_serv}`;
  db()
    .prepare(`
      INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(produto) DO UPDATE SET
        ctrib_nac  = excluded.ctrib_nac,
        cnbs       = excluded.cnbs,
        xdesc_serv = excluded.xdesc_serv
    `)
    .run(produtoChave, c.ctrib_nac, c.cnbs, c.xdesc_serv);

  return id;
}

/** Completa os dados fiscais e o endereço de um contrato legado. */
export function atualizarContrato(id: number, dados: DadosEnderecoContrato): void {
  const faltantes = camposContratoAusentes(dados);
  if (faltantes.length > 0) {
    throw new Error(`Contrato ${id} inválido: faltam ${faltantes.join(", ")}.`);
  }

  const resultado = db().prepare(`
    UPDATE contratos
    SET cliente_cmun = ?, cliente_cep = ?, cliente_rua = ?, cliente_numero = ?,
        cliente_complemento = ?, cliente_bairro = ?, cnbs = ?
    WHERE id = ?
  `).run(
    dados.cliente_cmun,
    dados.cliente_cep,
    dados.cliente_rua,
    dados.cliente_numero,
    dados.cliente_complemento ?? null,
    dados.cliente_bairro,
    dados.cnbs,
    id,
  );
  if (resultado.changes === 0) {
    throw new Error(`Contrato id=${id} não encontrado.`);
  }
}

/** Lista contratos (ativos por padrão; pass false para todos). */
export function listContratos(apenasAtivos = true): Contrato[] {
  const where = apenasAtivos ? "WHERE ativo = 1" : "";
  return db()
    .prepare(`SELECT * FROM contratos ${where} ORDER BY id`)
    .all() as unknown as Contrato[];
}

/** Desativa um contrato (soft-delete). */
export function desativarContrato(id: number): void {
  db()
    .prepare("UPDATE contratos SET ativo = 0 WHERE id = ?")
    .run(id);
}

/**
 * Gera vendas para todos os contratos ativos na competência indicada.
 *
 * @param competencia - string 'AAAA-MM'
 * @returns número de vendas novas inseridas (não conta as já existentes)
 *
 * Idempotência: id_venda determinístico = `contrato-<id>-<AAAA-MM>`.
 * Se a venda já existe com status 'simulada' ou 'emitida', não a regride.
 */
export interface ContratoPulado {
  id: number;
  cliente_nome: string;
  campos_faltantes: string[];
}

export interface ResultadoGeracaoVendas {
  novas: number;
  pulados: ContratoPulado[];
}

export function gerarVendasDoMesDetalhado(competencia: string): ResultadoGeracaoVendas {
  const match = /^(\d{4})-(\d{2})$/.exec(competencia);
  const mesCandidato = match ? parseInt(match[2], 10) : NaN;
  if (!match || mesCandidato < 1 || mesCandidato > 12) {
    throw new Error(`Competência inválida: "${competencia}" — use formato AAAA-MM`);
  }
  const ano = parseInt(match[1], 10);
  const mes = mesCandidato; // 1-12

  const contratos = listContratos(true);
  const pulados: ContratoPulado[] = [];
  const contratosValidos = contratos.filter((c) => {
    const faltantes = camposContratoAusentes(c);
    if (faltantes.length > 0) {
      pulados.push({
        id: c.id ?? 0,
        cliente_nome: c.cliente_nome,
        campos_faltantes: faltantes,
      });
      return false;
    }
    return true;
  });

  let novas = 0;

  for (const c of contratosValidos) {
    const idVenda = `contrato-${c.id}-${competencia}`;

    // Clamp: garante que o dia não ultrapasse o último dia do mês
    const ultimoDia = new Date(ano, mes, 0).getDate(); // dia 0 do mês seguinte = último do mês
    const dia = Math.min(c.dia_do_mes, ultimoDia);
    const dataVenda = `${competencia}-${String(dia).padStart(2, "0")}`;

    const produtoChave = `Contrato: ${c.xdesc_serv}`;

    // Verifica se já existe para não regredir status
    const existente = db()
      .prepare("SELECT id_venda, status FROM vendas WHERE id_venda = ?")
      .get(idVenda) as { id_venda: string; status: string } | undefined;

    if (existente) {
      // Já existe — não inserir novamente (idempotência)
      continue;
    }

    const now = new Date().toISOString();
    db()
      .prepare(`
        INSERT INTO vendas
          (id_venda, contrato_id, fonte, produto, valor, data_venda,
           discriminacao, cpf_cnpj, nome, email, cep, cmun, bairro, rua,
           numero, complemento,
           dias_garantia, estrangeiro, fila, status, criada_em, atualizada_em)
        VALUES (?, ?, 'contrato', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pronta', 'pronta', ?, ?)
      `)
      .run(
        idVenda,
        c.id,
        produtoChave,
        c.valor,
        dataVenda,
        c.xdesc_serv,
        c.cliente_doc,
        c.cliente_nome,
        c.cliente_email ?? null,
        c.cliente_cep,
        c.cliente_cmun,
        c.cliente_bairro,
        c.cliente_rua,
        c.cliente_numero,
        c.cliente_complemento ?? null,
        now,
        now,
      );

    novas++;
  }

  return { novas, pulados };
}

export function gerarVendasDoMes(competencia: string): number {
  return gerarVendasDoMesDetalhado(competencia).novas;
}

// ─── marcarStatus ─────────────────────────────────────────────────────────────

/**
 * Atualiza status/fila/erro de uma venda.
 * Nunca regride de 'emitida'.
 */
export function marcarStatus(idVenda: string, status: StatusVenda, erro?: string): void {
  const now = new Date().toISOString();

  const filaMap: Partial<Record<StatusVenda, FilaVenda | null>> = {
    pronta: "pronta",
    aguardando_garantia: "aguardando_garantia",
    pendente_cadastro: "pendente_cadastro",
    excecao: "excecao",
    pronta_sem_endereco: "pronta_sem_endereco",
    emitindo: null,
    simulada: "pronta",
    emitida: "pronta",
    a_verificar: null,
    erro: null,
  };
  const novaFila = Object.hasOwn(filaMap, status) ? filaMap[status] : "pronta";

  const vendaAtualizada = db()
    .prepare(`
      UPDATE vendas
      SET
        status        = CASE WHEN status = 'emitida' THEN 'emitida' ELSE ? END,
        fila          = CASE WHEN status = 'emitida' THEN fila ELSE ? END,
        erro          = ?,
        atualizada_em = ?
       WHERE id_venda = ? AND (status IS NULL OR status <> 'emitindo')
    `)
    .run(status, novaFila, erro ? mascararDocumentos(erro) : null, now, idVenda);
  exigirMudanca(vendaAtualizada.changes, `Transição da Venda ${idVenda} para ${status} não foi aplicada.`);
}
