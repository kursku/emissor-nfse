/**
 * contratos.ts — CLI de contratos recorrentes NFS-e
 *
 * Uso:
 *   nfse contratos criar --doc <CPF/CNPJ> --nome <nome> --valor <N> \
 *                              --desc <desc> --ctrib <cTribNac> \
 *                              [--email <e>] [--cnbs <cNBS>] [--dia <1-31>]
 *
 *   nfse contratos listar [--todos]
 *
 *   nfse contratos desativar <id>
 *
 *   nfse contratos gerar [AAAA-MM]   (padrão: mês corrente)
 */

import {
  initDb,
  criarContrato,
  listContratos,
  desativarContrato,
  gerarVendasDoMes,
} from "../store.js";

// ─── Helpers de argparse minimalista ─────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function obrigatorio(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) {
    console.error(`Parâmetro obrigatório ausente: ${name}`);
    process.exit(1);
  }
  return v;
}

function mesCorrente(): string {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  return `${ano}-${mes}`;
}

// ─── Subcomandos ──────────────────────────────────────────────────────────────

function cmdCriar(args: string[]): void {
  const doc      = obrigatorio(args, "--doc");
  const nome     = obrigatorio(args, "--nome");
  const valorStr = obrigatorio(args, "--valor");
  const desc     = obrigatorio(args, "--desc");
  const ctrib    = obrigatorio(args, "--ctrib");
  const email    = flag(args, "--email");
  const cnbs     = flag(args, "--cnbs");
  const diaStr   = flag(args, "--dia") ?? "1";

  const valor = parseFloat(valorStr);
  if (isNaN(valor) || valor <= 0) {
    console.error(`--valor inválido: "${valorStr}"`);
    process.exit(1);
  }

  const dia = parseInt(diaStr, 10);
  if (isNaN(dia) || dia < 1 || dia > 31) {
    console.error(`--dia deve ser entre 1 e 31 (recebido: "${diaStr}")`);
    process.exit(1);
  }

  initDb();

  const id = criarContrato({
    cliente_doc:   doc,
    cliente_nome:  nome,
    cliente_email: email,
    valor,
    xdesc_serv:    desc,
    ctrib_nac:     ctrib,
    cnbs,
    dia_do_mes:    dia,
  });

  console.log(`Contrato criado com id=${id}`);
  console.log(`  Cliente : ${nome} (${doc})`);
  console.log(`  Valor   : R$ ${valor.toFixed(2)}`);
  console.log(`  Serviço : ${desc}`);
  console.log(`  cTribNac: ${ctrib}${cnbs ? ` / cNBS: ${cnbs}` : ""}`);
  console.log(`  Dia     : ${dia} de cada mês`);
  console.log(`  Produto mapa_produtos: "Contrato: ${desc}"`);
}

function cmdListar(args: string[]): void {
  const todos = args.includes("--todos");

  initDb();

  const contratos = listContratos(!todos);

  if (contratos.length === 0) {
    console.log(todos ? "Nenhum contrato cadastrado." : "Nenhum contrato ativo.");
    return;
  }

  console.log(`\n${"ID".padEnd(5)} ${"DOC".padEnd(18)} ${"NOME".padEnd(30)} ${"VALOR".padStart(10)} ${"DIA".padStart(4)} ${"ATIVO"}`);
  console.log("─".repeat(80));

  for (const c of contratos) {
    const ativo  = c.ativo === 1 ? "sim" : "não";
    const valor  = `R$ ${c.valor.toFixed(2)}`;
    console.log(
      `${String(c.id).padEnd(5)} ${c.cliente_doc.padEnd(18)} ${c.cliente_nome.slice(0, 29).padEnd(30)} ${valor.padStart(10)} ${String(c.dia_do_mes).padStart(4)} ${ativo}`,
    );
  }
}

function cmdDesativar(args: string[]): void {
  const idStr = args[0];
  if (!idStr) {
    console.error("Uso: contratos.ts desativar <id>");
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id) || id <= 0) {
    console.error(`ID inválido: "${idStr}"`);
    process.exit(1);
  }

  initDb();
  desativarContrato(id);
  console.log(`Contrato id=${id} desativado.`);
}

function cmdGerar(args: string[]): void {
  const competencia = args[0] ?? mesCorrente();

  // Valida formato AAAA-MM
  if (!/^\d{4}-\d{2}$/.test(competencia)) {
    console.error(`Competência inválida: "${competencia}" — use formato AAAA-MM`);
    process.exit(1);
  }

  initDb();

  const novas = gerarVendasDoMes(competencia);
  console.log(`Competência ${competencia}: ${novas} venda(s) nova(s) gerada(s).`);

  if (novas === 0) {
    console.log("(Idempotente: todas as vendas do mês já existiam ou não há contratos ativos)");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const [, , subcmd, ...rest] = process.argv;

  switch (subcmd) {
    case "criar":
      cmdCriar(rest);
      break;
    case "listar":
      cmdListar(rest);
      break;
    case "desativar":
      cmdDesativar(rest);
      break;
    case "gerar":
      cmdGerar(rest);
      break;
    default:
      console.error(`Subcomando desconhecido: "${subcmd ?? ""}"`);
      console.error("Subcomandos disponíveis: criar | listar | desativar | gerar");
      process.exit(1);
  }
}

main();
