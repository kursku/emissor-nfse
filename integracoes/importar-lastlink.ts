/**
 * importar-lastlink.ts — Importador do relatório sales_list da Lastlink
 *
 * Uso:
 *   nfse importar "<path do xlsx>"
 *
 * Aba: SalesReport
 * Somente linhas com Status da venda = 'Aprovada' são inseridas.
 * As demais (Reembolsada, Expirada, Pendente) são contadas e reportadas.
 *
 * id_venda = Identificador da venda (UUID da Lastlink)
 * valor    = Comissão total de coprodutores  ← valor da nota NFS-e
 * valor_bruto = Valor da venda               ← preço cheio pago pelo cliente
 *
 * Datas em serial Excel (epoch 1899-12-30) → ISO AAAA-MM-DD.
 *
 * Filas (prioridade: excecao > pendente_cadastro > aguardando_garantia > pronta):
 *   excecao           — Sou Estrangeiro = 'Sim' OU produto sem mapa_produtos
 *                       OU Comissão total de coprodutores <= 0
 *   pendente_cadastro — sem Documento do membro OU sem Nome/Razão social do membro
 *   aguardando_garantia — Data da expiração >= hoje
 *   pronta            — todos os critérios satisfeitos
 *
 * Upsert idempotente: nunca regride status 'simulada' ou 'emitida'.
 */

import { readFileSync } from "node:fs";

import XLSX from "xlsx";

import { initDb, upsertVenda, listVendas } from "../store.js";
import type { Venda } from "../store.js";
import { parseEnderecoLastlink } from "./endereco-lastlink.js";
import type { EnderecoLastlink } from "./endereco-lastlink.js";

// ─── Endereco e codigo do municipio ───────────────────────────────────────────

/**
 * O endereco vem como texto na planilha e nao traz o codigo IBGE do municipio,
 * que a DPS exige. O CEP resolve isso: o ViaCEP devolve o codigo no campo
 * `ibge`. Cache em memoria porque CEPs se repetem no mesmo arquivo.
 */
const cacheCep = new Map<string, string | null>();

async function ibgeDoCep(cep: string): Promise<string | null> {
  if (cacheCep.has(cep)) return cacheCep.get(cep) ?? null;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = res.ok ? ((await res.json()) as { ibge?: string; erro?: boolean }) : null;
    const ibge = json && !json.erro && json.ibge ? String(json.ibge) : null;
    cacheCep.set(cep, ibge);
    return ibge;
  } catch {
    // Rede fora nao invalida a importacao: a venda entra sem cmun e cai em
    // pronta_sem_endereco, para ser reprocessada depois.
    cacheCep.set(cep, null);
    return null;
  }
}

// ─── Produtos mapeados ────────────────────────────────────────────────────────
// Vem da tabela mapa_produtos, nao de uma lista no codigo: manter as duas em
// sync na mao era garantia de divergencia. Produto que nao esta la cai em
// 'excecao' — cadastre-o em mapa_produtos com os codigos fiscais dele.
let PRODUTOS_MAPEADOS = new Set<string>();

function carregarProdutosMapeados(db: ReturnType<typeof initDb>): Set<string> {
  const rows = db.prepare("SELECT produto FROM mapa_produtos").all() as Array<{
    produto: string;
  }>;
  return new Set(rows.map((r) => r.produto));
}

// ─── Interface de linha bruta ─────────────────────────────────────────────────

interface RawRow {
  "Identificador da venda"?: string;
  "Status da venda"?: string;
  "Data da Venda"?: number | string;
  "E-mail do membro"?: string;
  "Nome/Razão social do membro"?: string;
  "Telefone do membro"?: string;
  "Documento do membro"?: string | number;
  "Produto principal"?: string;
  "Valor da venda"?: string | number;
  "Comissão total de coprodutores"?: string | number;
  "Data da expiração"?: number | string;
  "Sou Estrangeiro"?: string;
  "Coprodutores"?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseNum(v: unknown): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

/**
 * Converte serial Excel para ISO AAAA-MM-DD.
 * Epoch Excel: 1899-12-30 (dia 0).
 * Serial é número de dias desde essa data; parte fracionária = hora do dia.
 */
function excelSerialToIso(serial: unknown): string | undefined {
  const n = parseFloat(String(serial));
  if (isNaN(n) || n <= 0) return undefined;
  // 1899-12-30 em ms UTC
  const EPOCH_MS = Date.UTC(1899, 11, 30);
  const dateMs = EPOCH_MS + n * 86_400_000;
  const d = new Date(dateMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Classifica a fila da venda.
 * Prioridade: excecao > pendente_cadastro > aguardando_garantia > pronta
 */
function classificarFila(
  row: RawRow,
  hoje: Date,
  temEnderecoCompleto: boolean,
): "excecao" | "pendente_cadastro" | "aguardando_garantia" | "pronta_sem_endereco" | "pronta" {
  const produto = str(row["Produto principal"]);
  const isEstrangeiro = str(row["Sou Estrangeiro"]).toLowerCase() === "sim";
  const comissao = parseNum(row["Comissão total de coprodutores"]);

  // excecao: estrangeiro, produto sem mapa, ou comissão zerada em linha Aprovada
  if (isEstrangeiro || !PRODUTOS_MAPEADOS.has(produto) || comissao <= 0) {
    return "excecao";
  }

  const cpf = str(row["Documento do membro"]);
  const nome = str(row["Nome/Razão social do membro"]);
  if (!cpf || !nome) return "pendente_cadastro";

  // aguardando_garantia: data de expiração >= hoje
  const expiracaoIso = excelSerialToIso(row["Data da expiração"]);
  if (expiracaoIso) {
    const expDate = new Date(expiracaoIso + "T00:00:00Z");
    if (expDate >= hoje) return "aguardando_garantia";
  }

  // Sem endereço a SEFIN recusa com E0234 — a venda fica visível numa fila
  // própria em vez de falhar só na hora de emitir.
  if (!temEnderecoCompleto) return "pronta_sem_endereco";

  return "pronta";
}

// ─── Normalização de linha ────────────────────────────────────────────────────

function normalizarVenda(
  row: RawRow,
  hoje: Date,
  end: EnderecoLastlink | null,
  cmun: string | null,
): Venda {
  const id_venda = str(row["Identificador da venda"]);
  const temEnderecoCompleto = Boolean(end && cmun);
  const fila = classificarFila(row, hoje, temEnderecoCompleto);
  const comissao = parseNum(row["Comissão total de coprodutores"]);
  const valorBruto = parseNum(row["Valor da venda"]);

  return {
    id_venda,
    fonte: "lastlink",
    produto: str(row["Produto principal"]) || undefined,
    // valor = comissão do coprodutor = valor da NFS-e
    valor: comissao > 0 ? comissao : undefined,
    // valor_bruto = preço cheio pago pelo cliente
    valor_bruto: valorBruto > 0 ? valorBruto : undefined,
    data_venda: excelSerialToIso(row["Data da Venda"]),
    data_expiracao: excelSerialToIso(row["Data da expiração"]),
    status_lastlink: str(row["Status da venda"]) || undefined,
    cpf_cnpj: str(row["Documento do membro"]) || undefined,
    nome: str(row["Nome/Razão social do membro"]) || undefined,
    email: str(row["E-mail do membro"]) || undefined,
    telefone: str(row["Telefone do membro"]) || undefined,
    estrangeiro: str(row["Sou Estrangeiro"]).toLowerCase() === "sim" ? 1 : 0,
    ...(end
      ? {
          cep: end.CEP,
          rua: end.xLgr,
          numero: end.nro,
          bairro: end.xBairro,
          cidade: end.cidade,
          uf: end.uf,
        }
      : {}),
    ...(cmun ? { cmun } : {}),
    fila,
    status: fila, // status inicial = fila
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Uso: nfse importar "<path do xlsx>"');
    process.exit(1);
  }

  const xlsxPath = args[0];

  // Inicializa banco (inclui migração de colunas)
  const db = initDb();
  PRODUTOS_MAPEADOS = carregarProdutosMapeados(db);

  // Lê xlsx
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(xlsxPath);
  } catch (err) {
    console.error(`Erro ao abrir xlsx: ${err}`);
    process.exit(1);
  }

  // Usa aba SalesReport se existir, senão a primeira
  const sheetName = wb.SheetNames.includes("SalesReport")
    ? "SalesReport"
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<RawRow>(ws);

  if (rows.length === 0) {
    console.log("Arquivo vazio — nenhuma venda importada.");
    return;
  }

  // Hoje sem hora para comparação de datas
  const hoje = new Date();
  hoje.setUTCHours(0, 0, 0, 0);

  // Contagens por status Lastlink (antes de filtrar)
  const contagemStatus: Record<string, number> = {};
  for (const row of rows) {
    const s = str(row["Status da venda"]) || "(sem status)";
    contagemStatus[s] = (contagemStatus[s] ?? 0) + 1;
  }

  // Contagens por fila (somente Aprovadas)
  const contagemFila: Record<string, number> = {
    excecao: 0,
    pendente_cadastro: 0,
    aguardando_garantia: 0,
    pronta_sem_endereco: 0,
    pronta: 0,
  };

  let totalInseridas = 0;
  let somaComissao = 0;

  for (const row of rows) {
    const statusVenda = str(row["Status da venda"]);

    // Apenas Aprovadas entram no banco
    if (statusVenda !== "Aprovada") continue;

    // Endereco: parse do texto da planilha + codigo IBGE pelo CEP.
    const end = parseEnderecoLastlink(row["Endereço do membro"]);
    const cmun = end ? await ibgeDoCep(end.CEP) : null;

    const venda = normalizarVenda(row, hoje, end, cmun);

    // Validação de id_venda (deve ser UUID preenchido)
    if (!venda.id_venda) {
      console.warn("Linha sem Identificador da venda — ignorada");
      continue;
    }

    upsertVenda(venda);
    contagemFila[venda.fila ?? "pronta"] = (contagemFila[venda.fila ?? "pronta"] ?? 0) + 1;
    somaComissao += venda.valor ?? 0;
    totalInseridas++;
  }

  // Contagem real no banco (confirma idempotência)
  const totalBanco = listVendas().length;

  console.log("\n=== Importação Lastlink (sales_list) ===");
  console.log(`Arquivo      : ${xlsxPath}`);
  console.log(`Aba          : ${sheetName}`);
  console.log(`Total linhas : ${rows.length}`);
  console.log(`\n--- Contagem por Status Lastlink ---`);
  for (const [s, n] of Object.entries(contagemStatus)) {
    const marker = s === "Aprovada" ? " ✓ inseridas" : " — não inseridas";
    console.log(`  ${s.padEnd(18)}: ${n}${marker}`);
  }
  console.log(`\n--- Contagens por fila (Aprovadas) ---`);
  for (const [fila, n] of Object.entries(contagemFila)) {
    console.log(`  ${fila.padEnd(22)}: ${n}`);
  }
  console.log("─".repeat(40));
  console.log(`  ${"TOTAL INSERIDAS".padEnd(22)}: ${totalInseridas}`);
  console.log(`  ${"Rows no banco".padEnd(22)}: ${totalBanco}`);
  console.log(`\n  Soma comissão (valor NFS-e): R$ ${somaComissao.toFixed(2)}`);
}

main().catch((err) => {
  console.error("Erro fatal na importacao:", err);
  process.exit(1);
});