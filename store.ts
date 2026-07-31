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
 *   proximoNDPS()         — próximo nDPS (MAX+1, seed via ndps.json)
 *   registrarNota(n)      — insere na tabela notas
 *   marcarStatus(id, s)   — atualiza fila/status/erro de uma venda
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Estado do processamento de uma venda. */
export type StatusVenda =
  | "pendente"
  | "pronta"
  | "simulada"
  | "emitida"
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

export interface FiltroVendas {
  fila?: FilaVenda;
  status?: StatusVenda;
  id_venda?: string;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null;

function resolveDbPath(): string {
  const scriptDir = join(fileURLToPath(import.meta.url), "..");
  // Primeira execucao numa instalacao limpa: sem a pasta, o SQLite falha com
  // "unable to open database file" antes de qualquer mensagem util.
  mkdirSync(join(scriptDir, "output"), { recursive: true });
  return join(scriptDir, "output", "emissor.db");
}

// ─── initDb ──────────────────────────────────────────────────────────────────

export function initDb(): DatabaseSync {
  if (_db) return _db;

  _db = new DatabaseSync(resolveDbPath());

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
  migrarColunas(_db);

  criarTabelaContratos();
  seedMapaProdutos();
  return _db;
}

function db(): DatabaseSync {
  if (!_db) throw new Error("DB não inicializado — chame initDb() antes.");
  return _db;
}

// ─── Migração de colunas ──────────────────────────────────────────────────────

/**
 * Adiciona colunas novas à tabela vendas sem destruir dados existentes.
 * Cada ALTER TABLE é envolvido em try/catch para ser idempotente
 * (SQLite retorna erro se a coluna já existe).
 */
function migrarColunas(database: DatabaseSync): void {
  const novasColunas: Array<{ nome: string; ddl: string }> = [
    { nome: "valor_bruto",     ddl: "ALTER TABLE vendas ADD COLUMN valor_bruto     REAL" },
    { nome: "status_lastlink", ddl: "ALTER TABLE vendas ADD COLUMN status_lastlink TEXT" },
    { nome: "data_expiracao",  ddl: "ALTER TABLE vendas ADD COLUMN data_expiracao  TEXT" },
    { nome: "cmun",            ddl: "ALTER TABLE vendas ADD COLUMN cmun            TEXT" },
  ];

  // Colunas existentes
  const existentes = new Set(
    (database.prepare("PRAGMA table_info(vendas)").all() as Array<{ name: string }>)
      .map((c) => c.name),
  );

  for (const col of novasColunas) {
    if (!existentes.has(col.nome)) {
      try {
        database.exec(col.ddl);
      } catch {
        // Já existe (race condition improvável mas seguro ignorar)
      }
    }
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
      (id_venda, fonte, produto, valor, valor_bruto, data_venda, data_expiracao,
       status_lastlink, discriminacao,
       cpf_cnpj, nome, email, telefone, cep, cmun, cidade, uf, bairro,
       rua, numero, complemento, dias_garantia, estrangeiro,
       fila, status, erro, criada_em, atualizada_em)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_venda) DO UPDATE SET
      fonte           = excluded.fonte,
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
        WHEN vendas.status IN ('emitida', 'simulada') THEN vendas.fila
        ELSE excluded.fila
      END,
      status = CASE
        WHEN vendas.status IN ('emitida', 'simulada') THEN vendas.status
        ELSE excluded.status
      END,
      atualizada_em = ?
  `).run(
    v.id_venda,
    v.fonte ?? null,
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
 * Retorna o próximo nDPS.
 * 1. Lê MAX(ndps) da tabela notas.
 * 2. Se tabela vazia, lê seed de output/nfewizard/ndps.json.
 * 3. Retorna MAX+1 (nunca menos que o seed).
 */
export function proximoNDPS(): number {
  const row = db()
    .prepare("SELECT MAX(ndps) AS maxNdps FROM notas")
    .get() as { maxNdps: number | null } | null;

  const maxDb = row?.maxNdps ?? 0;

  let seed = 1;
  if (maxDb === 0) {
    const ndpsPath = join(
      fileURLToPath(import.meta.url),
      "..",
      "output",
      "nfewizard",
      "ndps.json",
    );
    if (existsSync(ndpsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(ndpsPath, "utf-8")) as {
          proximoNDPS?: number;
        };
        if (typeof parsed.proximoNDPS === "number") seed = parsed.proximoNDPS;
      } catch {
        // ignora JSON malformado
      }
    }
  }

  return Math.max(maxDb + 1, seed);
}

// ─── registrarNota ────────────────────────────────────────────────────────────

export function registrarNota(n: NotaFiscal): void {
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
  valor: number;
  xdesc_serv: string;
  ctrib_nac: string;
  cnbs?: string;
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
      dia_do_mes   INTEGER NOT NULL,
      ativo        INTEGER DEFAULT 1,
      criado_em    TEXT
    );
  `);
}

/** Cria um novo contrato recorrente e insere/atualiza mapa_produtos correspondente. */
export function criarContrato(c: Omit<Contrato, "id" | "criado_em">): number {
  const now = new Date().toISOString();
  const result = db()
    .prepare(`
      INSERT INTO contratos
        (cliente_doc, cliente_nome, cliente_email, valor, xdesc_serv,
         ctrib_nac, cnbs, dia_do_mes, ativo, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)
    .run(
      c.cliente_doc,
      c.cliente_nome,
      c.cliente_email ?? null,
      c.valor,
      c.xdesc_serv,
      c.ctrib_nac,
      c.cnbs ?? null,
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
    .run(produtoChave, c.ctrib_nac, c.cnbs ?? null, c.xdesc_serv);

  return id;
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
export function gerarVendasDoMes(competencia: string): number {
  const [anoStr, mesStr] = competencia.split("-");
  if (!anoStr || !mesStr) {
    throw new Error(`Competência inválida: "${competencia}" — use formato AAAA-MM`);
  }
  const ano = parseInt(anoStr, 10);
  const mes = parseInt(mesStr, 10); // 1-12

  const contratos = listContratos(true);
  let novas = 0;

  for (const c of contratos) {
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
          (id_venda, fonte, produto, valor, data_venda,
           discriminacao, cpf_cnpj, nome, email,
           dias_garantia, estrangeiro, fila, status, criada_em, atualizada_em)
        VALUES (?, 'contrato', ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pronta', 'pronta', ?, ?)
      `)
      .run(
        idVenda,
        produtoChave,
        c.valor,
        dataVenda,
        c.xdesc_serv,
        c.cliente_doc,
        c.cliente_nome,
        c.cliente_email ?? null,
        now,
        now,
      );

    novas++;
  }

  return novas;
}

// ─── marcarStatus ─────────────────────────────────────────────────────────────

/**
 * Atualiza status/fila/erro de uma venda.
 * Nunca regride de 'emitida'.
 */
export function marcarStatus(idVenda: string, status: StatusVenda, erro?: string): void {
  const now = new Date().toISOString();

  const filaMap: Partial<Record<StatusVenda, FilaVenda>> = {
    pronta: "pronta",
    aguardando_garantia: "aguardando_garantia",
    pendente_cadastro: "pendente_cadastro",
    excecao: "excecao",
    pronta_sem_endereco: "pronta_sem_endereco",
    simulada: "pronta",
    emitida: "pronta",
    erro: "pronta",
  };
  const novaFila = filaMap[status] ?? "pronta";

  db()
    .prepare(`
      UPDATE vendas
      SET
        status        = CASE WHEN status = 'emitida' THEN 'emitida' ELSE ? END,
        fila          = CASE WHEN status = 'emitida' THEN fila ELSE ? END,
        erro          = ?,
        atualizada_em = ?
      WHERE id_venda = ?
    `)
    .run(status, novaFila, erro ?? null, now, idVenda);
}
