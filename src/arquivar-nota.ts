/** Organiza uma NFS-e emitida em pasta própria. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { chaveAcessoValida } from './chave-acesso.js';
import { obterDanfse } from './danfse.js';
import type { ResultadoDanfse } from './danfse.js';
import { exigirIdentificadorSeguro } from './validar-emissao.js';

const BASE = join(import.meta.dirname, '..');

export interface ArquivarNotaDeps {
  baseDir?: string;
  dbPath?: string;
  outputDir?: string;
  ambiente?: 1 | 2;
  obterDanfse?: (chave: string, deps?: { outputDir?: string; ambiente?: 1 | 2 }) => Promise<ResultadoDanfse | null>;
}

export async function arquivarNota(idVenda: string, deps: ArquivarNotaDeps = {}): Promise<void> {
  exigirIdentificadorSeguro(idVenda, 'id da Venda');
  const base = deps.baseDir ?? BASE;
  const configuracao = deps.outputDir === undefined || deps.ambiente === undefined
    ? (await import('./config.js')).config
    : undefined;
  const outputDir = deps.outputDir ?? configuracao!.outputDir;
  const ambiente = deps.ambiente ?? configuracao!.ambiente;
  const db = new DatabaseSync(deps.dbPath ?? join(base, 'output', 'emissor.db'));

  try {
    const nota = db
      .prepare('SELECT chave_acesso, ndps FROM notas WHERE id_venda = ?')
      .get(idVenda) as { chave_acesso: string; ndps: number } | undefined;
    if (!nota) throw new Error(`Sem nota emitida para id_venda=${idVenda} (tabela notas vazia).`);
    const venda = db
      .prepare('SELECT data_venda FROM vendas WHERE id_venda = ?')
      .get(idVenda) as { data_venda?: string } | undefined;
    const comp = (venda?.data_venda ?? '0000-00').slice(0, 7);
    const chave = nota.chave_acesso;
    if (!chaveAcessoValida(chave)) throw new Error('Chave de acesso inválida no banco.');

    const destDir = join(base, 'output', 'notas', comp, idVenda);
    mkdirSync(destDir, { recursive: true });
    const xmlSrc = join(outputDir, 'autorizacao', `${chave}.xml`);
    if (existsSync(xmlSrc)) {
      copyFileSync(xmlSrc, join(destDir, 'nfse.xml'));
      console.log(`XML  -> ${join(destDir, 'nfse.xml')}`);
    } else {
      console.log(`AVISO: XML autorizado não encontrado em ${xmlSrc}.`);
    }

    const buscar = deps.obterDanfse ?? obterDanfse;
    const danfse = await buscar(chave, { outputDir, ambiente });
    if (danfse && 'pdf' in danfse) {
      writeFileSync(join(destDir, 'danfse.pdf'), danfse.pdf);
      console.log(`PDF  -> ${join(destDir, 'danfse.pdf')} (${danfse.pdf.length} bytes)`);
    } else if (danfse && 'html' in danfse) {
      writeFileSync(join(destDir, 'danfse.html'), danfse.html, 'utf8');
      console.log(`HTML -> ${join(destDir, 'danfse.html')}`);
    } else {
      console.log('AVISO: DANFSe indisponivel.');
    }

    console.log(`\nNota ${idVenda} arquivada. chave=${chave} competência=${comp}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const idVenda = process.argv[2];
  if (!idVenda) {
    console.error('Uso: nfse arquivar <id_venda>');
    process.exitCode = 1;
  } else {
    try {
      await arquivarNota(idVenda);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}
