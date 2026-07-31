/**
 * emitir-avulsa.ts — emissão real de uma NFS-e única a partir de um arquivo JSON.
 *
 * Uso:
 *   nfse emitir nota.json           confere e mostra o que seria enviado
 *   nfse emitir nota.json --real    emite de verdade (irreversivel)
 *
 * Formato do JSON (ver nota-exemplo.json):
 * {
 *   "idVenda": "cliente-2026-01",
 *   "produto": "consultoria",
 *   "tomador": { "CNPJ": "...", "xNome": "...", "end": {...}, "email": "..." },
 *   "xDescServ": "...", "vServ": 100.0,
 *   "cTribNac": "080201", "cNBS": "122051900"
 * }
 *
 * Emissão em produção é irreversível — só se corrige por substituição, no prazo
 * do município. Confira o JSON antes de rodar.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmissaoInput } from './montar-dps.js';
import { config } from './config.js';
import { conferirDps } from './dps-xml.js';
import { initDb, proximoNDPS, registrarNota, upsertVenda } from './store.js';
import {
  cepInvalido,
  cNBSInvalido,
  cTribNacInvalido,
  codMunicipioInvalido,
  docTomadorInvalido,
  vServInvalido,
} from './validacoes.mjs';

interface NotaAvulsa extends Omit<EmissaoInput, 'nDPS' | 'cIndOp' | 'cClassTrib'> {
  idVenda: string;
  produto?: string;
  cIndOp?: string;
  cClassTrib?: string;
}

/** Chave = nome do XML mais novo em autorizacao/ (a lib grava <chave>.xml no sucesso). */
function chaveDoXmlMaisNovo(): string | null {
  const dir = join(config.outputDir, 'autorizacao');
  const xmls = readdirSync(dir).filter((f) => f.endsWith('.xml'));
  if (xmls.length === 0) return null;
  const novo = xmls
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return novo.f.replace(/\.xml$/, '');
}

function carregar(path: string): NotaAvulsa {
  const nota = JSON.parse(readFileSync(path, 'utf-8')) as NotaAvulsa;
  const faltando = (
    ['idVenda', 'tomador', 'xDescServ', 'vServ', 'cTribNac', 'cNBS'] as const
  ).filter((k) => nota[k] === undefined || nota[k] === null);
  if (faltando.length > 0) {
    throw new Error(`Campos ausentes no JSON: ${faltando.join(', ')}`);
  }
  // Formato dos codigos fiscais: errado aqui = nota errada, e nota emitida
  // em producao nao se desfaz.
  const problemas = [
    docTomadorInvalido(nota.tomador),
    cTribNacInvalido(nota.cTribNac),
    cNBSInvalido(nota.cNBS),
    vServInvalido(nota.vServ),
    nota.tomador.end ? cepInvalido(nota.tomador.end.CEP) : null,
    nota.tomador.end ? codMunicipioInvalido(nota.tomador.end.cMun) : null,
  ].filter(Boolean);
  if (problemas.length > 0) {
    throw new Error(`JSON invalido:\n  - ${problemas.join('\n  - ')}`);
  }
  return nota;
}

/**
 * Dry-run: monta a DPS de verdade, valida contra o XSD e grava o XML para
 * conferencia. Nada e enviado e nada e gravado no banco.
 */
async function conferir(input: EmissaoInput, nota: NotaAvulsa): Promise<void> {
  const doc = input.tomador.CNPJ ?? input.tomador.CPF ?? '';
  const valor = input.vServ.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });

  console.log('\n=== CONFERENCIA (nada foi enviado) ===\n');
  console.log(`  id_venda ....... ${nota.idVenda}`);
  console.log(`  nDPS ........... ${input.nDPS}   <- proximo numero que sera usado`);
  console.log(`  tomador ........ ${input.tomador.xNome} (${doc})`);
  console.log(`  valor .......... ${valor}`);
  console.log(`  servico ........ cTribNac ${input.cTribNac} | cNBS ${input.cNBS}`);
  console.log(`  descricao ...... ${input.xDescServ}`);
  console.log(`  tributos ....... ${input.pTotTribSN ?? config.pTotTribSN}% (pTotTribSN)`);
  console.log(
    `  ambiente ....... ${config.ambiente === 1 ? 'PRODUCAO — a nota valera de verdade' : 'producao restrita'}`,
  );

  const { ok, msg, xml } = await conferirDps(input, config);
  console.log(`\n  XSD ............ ${ok ? 'OK' : 'FALHOU'} — ${msg}`);

  if (xml) {
    const destino = join(config.outputDir, `dry-run-${nota.idVenda}.xml`);
    mkdirSync(config.outputDir, { recursive: true });
    writeFileSync(destino, xml, 'utf-8');
    console.log(`  XML ............ ${destino}`);
  }

  if (!ok) {
    console.error('\nCorrija o JSON antes de emitir.');
    process.exit(1);
  }

  console.log(
    `\nConfira os dados acima. Para emitir de verdade:\n  nfse emitir ${jsonPathArg()} --real\n`,
  );
}

/** O caminho do JSON como o usuario digitou, para repetir no comando sugerido. */
function jsonPathArg(): string {
  const p = process.argv[2] ?? 'nota.json';
  return p.includes(' ') ? `"${p}"` : p;
}

async function main(): Promise<void> {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('Uso: EMITIR_REAL=1 npx tsx emitir-avulsa.ts <nota.json>');
    process.exit(1);
  }
  const nota = carregar(jsonPath);
  initDb();
  const nDPS = String(proximoNDPS());

  const input: EmissaoInput = {
    nDPS,
    tomador: nota.tomador,
    xDescServ: nota.xDescServ,
    vServ: nota.vServ,
    cTribNac: nota.cTribNac,
    cNBS: nota.cNBS,
    cIndOp: nota.cIndOp ?? '100301',
    cClassTrib: nota.cClassTrib ?? '000001',
    ...(nota.pTotTribSN !== undefined ? { pTotTribSN: nota.pTotTribSN } : {}),
  };

  // Sem --real: confere e para. Onde o municipio nao tem producao restrita,
  // esta e a unica conferencia possivel antes de a nota valer de verdade.
  if (process.env['EMITIR_REAL'] !== '1') {
    await conferir(input, nota);
    return;
  }

  console.log(`Emitindo nDPS=${nDPS} para ${input.tomador.xNome} (${nota.idVenda})...`);
  // Só aqui o emissor entra: importar no topo criaria diretórios e trocaria o
  // agente HTTPS global mesmo numa conferência.
  const { emitirNfse } = await import('./emissor.js');
  const resultado = await emitirNfse(input);
  const r = resultado as Record<string, unknown>;
  let chave = (r['chNFSe'] as string) ?? (r['chaveAcesso'] as string) ?? '';
  // Fallback: a lib às vezes não parseia o retorno; pega a chave do XML autorizado gravado.
  if (!/^\d{50}$/.test(chave)) {
    chave = chaveDoXmlMaisNovo() ?? '';
  }
  if (!/^\d{50}$/.test(chave)) {
    throw new Error(
      `Nota autorizada mas chave não capturada (valor: "${chave}"). Ver ${join(config.outputDir, 'autorizacao')}.`,
    );
  }

  // notas.id_venda tem FK para vendas — garante a linha antes de registrar.
  upsertVenda({
    id_venda: nota.idVenda,
    fonte: 'avulsa',
    produto: nota.produto ?? 'avulsa',
    valor: input.vServ,
    data_venda: new Date().toISOString().slice(0, 10),
    cpf_cnpj: input.tomador.CNPJ ?? input.tomador.CPF,
    nome: input.tomador.xNome,
    ...(input.tomador.email ? { email: input.tomador.email } : {}),
    fila: 'pronta',
    status: 'emitida',
  });
  registrarNota({
    chave_acesso: chave,
    ndps: Number(nDPS),
    id_venda: nota.idVenda,
    emitida_em: new Date().toISOString(),
  });

  console.log(`AUTORIZADA. chave=${chave}`);
  console.log(`Arquivar: npx tsx arquivar-nota.ts ${nota.idVenda}`);
}

main().catch((err) => {
  // Erro completo, com stack: e o caminho de emissao real e irreversivel —
  // diagnostico truncado aqui custa caro.
  console.error('FALHA na emissão:', err);
  process.exit(1);
});
