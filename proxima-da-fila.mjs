/**
 * Mostra as proximas vendas da fila sem alterar nada.
 * Documento e e-mail sao mascarados: o terminal nao precisa ver o dado inteiro.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(import.meta.dirname, 'output', 'emissor.db'), {
  readOnly: true,
});

const mascara = (v) => {
  const s = String(v ?? '');
  if (s.length <= 4) return '***';
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(0, s.length - 5))}${s.slice(-2)}`;
};
const mascaraEmail = (v) => {
  const s = String(v ?? '');
  const [u, d] = s.split('@');
  if (!d) return '***';
  return `${u.slice(0, 2)}***@${d}`;
};

const linhas = db
  .prepare(
    `SELECT id_venda, data_venda, data_expiracao, produto, valor, nome, cpf_cnpj, email
       FROM vendas
      WHERE fila = 'pronta' AND status NOT IN ('simulada', 'emitida')
      ORDER BY data_venda ASC
      LIMIT 3`,
  )
  .all();

console.log(`proximas da fila (ordem de emissao) — ${linhas.length} mostradas\n`);
for (const [i, v] of linhas.entries()) {
  const doc = String(v.cpf_cnpj ?? '').replace(/\D/g, '');
  console.log(`[${i + 1}] id_venda ..... ${v.id_venda}`);
  console.log(`    data venda ... ${v.data_venda}   (garantia ate ${v.data_expiracao ?? '-'})`);
  console.log(`    produto ...... ${v.produto}`);
  console.log(`    valor ........ R$ ${Number(v.valor).toFixed(2)}`);
  console.log(
    `    tomador ...... ${String(v.nome ?? '').slice(0, 18)}... | doc ${mascara(doc)} (${doc.length} digitos)`,
  );
  console.log(`    email ........ ${mascaraEmail(v.email)}\n`);
}

const totais = db
  .prepare(
    `SELECT COUNT(*) AS n, SUM(valor) AS soma
       FROM vendas
      WHERE fila = 'pronta' AND status NOT IN ('simulada', 'emitida')`,
  )
  .get();
console.log(`fila pronta: ${totais.n} vendas | R$ ${Number(totais.soma).toFixed(2)}`);
