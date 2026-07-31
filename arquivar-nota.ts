/**
 * arquivar-nota.ts — organiza uma NFS-e emitida em pasta própria.
 *
 * Uso: npx tsx arquivar-nota.ts <id_venda>
 *
 * Lê chave (tabela notas) e competência (vendas.data_venda) do banco, então:
 *   - copia o XML autorizado (<output>/autorizacao/<chave>.xml) → nfse.xml
 *   - baixa o DANFSe da SEFIN nacional (ADN) → danfse.pdf
 * Destino: output/notas/<AAAA-MM>/<id_venda>/
 *
 * Idempotente: sobrescreve os arquivos de destino.
 */
import { writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { getComCertificado } from './http-mtls.js';

const BASE = import.meta.dirname;
const idVenda = process.argv[2];
if (!idVenda) {
  console.error('Uso: npx tsx arquivar-nota.ts <id_venda>');
  process.exit(1);
}

const db = new DatabaseSync(join(BASE, 'output', 'emissor.db'));
const nota = db
  .prepare('SELECT chave_acesso, ndps FROM notas WHERE id_venda = ?')
  .get(idVenda) as { chave_acesso: string; ndps: number } | undefined;
if (!nota) {
  console.error(`Sem nota emitida para id_venda=${idVenda} (tabela notas vazia).`);
  process.exit(1);
}
const venda = db
  .prepare('SELECT data_venda FROM vendas WHERE id_venda = ?')
  .get(idVenda) as { data_venda?: string } | undefined;
const comp = (venda?.data_venda ?? '0000-00').slice(0, 7);
const chave = nota.chave_acesso;

const destDir = join(BASE, 'output', 'notas', comp, idVenda);
mkdirSync(destDir, { recursive: true });

// XML autorizado
const xmlSrc = join(config.outputDir, 'autorizacao', `${chave}.xml`);
if (existsSync(xmlSrc)) {
  copyFileSync(xmlSrc, join(destDir, 'nfse.xml'));
  console.log(`XML  -> ${join(destDir, 'nfse.xml')}`);
} else {
  console.log(`AVISO: XML autorizado não encontrado em ${xmlSrc}`);
}

// DANFSe (PDF) via ADN

const { status: s, contentType: ct, buf } = await getComCertificado(`https://adn.nfse.gov.br/danfse/${chave}`);
if ((ct.includes('pdf') || buf.subarray(0, 4).toString() === '%PDF') && buf.length > 1000) {
  writeFileSync(join(destDir, 'danfse.pdf'), buf);
  console.log(`PDF  -> ${join(destDir, 'danfse.pdf')} (${buf.length} bytes)`);
} else {
  console.log(`AVISO: DANFSe não baixado (HTTP ${s}, ct=${ct}, ${buf.length} bytes)`);
}

console.log(`\nNota ${idVenda} arquivada. chave=${chave} competência=${comp}`);
