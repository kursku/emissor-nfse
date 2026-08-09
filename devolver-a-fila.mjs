/**
 * Devolve para a fila uma venda que foi marcada como 'simulada'.
 *
 * Simular consome a venda: a fila real so pega quem nao esta 'simulada' nem
 * 'emitida'. Para emitir de verdade a mesma venda que acabou de ser conferida,
 * o status volta para 'pronta'.
 *
 * Nunca mexe em venda 'emitida' — essa ja virou documento fiscal.
 *
 * Uso: node devolver-a-fila.mjs [id_venda]   (sem argumento: todas as simuladas)
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(import.meta.dirname, 'output', 'emissor.db'));
const idVenda = process.argv[2];

const where = idVenda ? "status = 'simulada' AND id_venda = ?" : "status = 'simulada'";
const params = idVenda ? [idVenda] : [];

const alvos = db
  .prepare(`SELECT id_venda, produto, valor FROM vendas WHERE ${where}`)
  .all(...params);

if (alvos.length === 0) {
  console.log('Nenhuma venda simulada para devolver.');
  process.exit(0);
}

db.prepare(
  `UPDATE vendas SET status = 'pronta', fila = 'pronta', atualizada_em = ? WHERE ${where}`,
).run(new Date().toISOString(), ...params);

console.log(`Devolvidas a fila: ${alvos.length}`);
for (const v of alvos) {
  console.log(`  ${v.id_venda} | ${v.produto} | R$ ${Number(v.valor).toFixed(2)}`);
}
