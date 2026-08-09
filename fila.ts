/**
 * fila.ts — Processador da fila de emissão NFS-e
 *
 * Uso:
 *   npx tsx fila.ts [--limite N]
 *
 * MODO SIMULAÇÃO (padrão):
 *   Monta a DPS, gera XML via xml2js (igual à lib), valida contra o XSD
 *   DPS_v1.01.xsd via NFE_SchemaValidate (@nfewizard/shared), marca 'simulada'.
 *   Nenhuma requisição de rede é feita.
 *
 * MODO REAL (EMITIR_REAL=1):
 *   Consome proximoNDPS(), chama emitirNfse(), registra nota, marca 'emitida'.
 *   Erro não trava a fila (continua). Pausa de 1s entre envios.
 *   NÃO exercitar este modo nos testes — requer certificado + SEFIN online.
 */


import { fileURLToPath } from 'node:url';
import {
  initDb,
  listVendas,
  marcarStatus,
  proximoNDPS,
  registrarNota,
} from './store.js';
import type { Venda } from './store.js';
import { montarDps as montarDpsPuro } from './montar-dps.js';
import type { EmissaoInput } from './montar-dps.js';
import { config } from './config.js';
import { conferirDps } from './dps-xml.js';
import { buscarMapaProduto, montarInput } from './fila-helpers.js';

// ─── Constantes ────────────────────────────────────────────────────────────────

const MODO_REAL = process.env['EMITIR_REAL'] === '1';

// Simulacao nao carrega emissor.ts nem email.ts: eles criam diretorios, trocam
// o agente HTTPS global e exigem o certificado. Import dinamico no modo real.


// ─── Processamento de uma venda ───────────────────────────────────────────────

async function processarVenda(
  venda: Venda,
  db: ReturnType<typeof initDb>,
  ndpsSimLocal: number,
): Promise<{ resultado: 'simulada' | 'emitida' | 'erro'; msg: string }> {
  // Busca mapa fiscal
  const mapa = buscarMapaProduto(db, venda.produto ?? '');
  if (!mapa) {
    return {
      resultado: 'erro',
      msg: `Produto sem mapeamento fiscal: "${venda.produto}"`,
    };
  }

  let input: EmissaoInput;
  try {
    const nDPS = MODO_REAL ? String(proximoNDPS()) : String(ndpsSimLocal);
    input = montarInput(venda, mapa, nDPS);
  } catch (err) {
    return { resultado: 'erro', msg: String(err) };
  }

  if (!MODO_REAL) {
    // ── SIMULAÇÃO ──
    const { ok, msg } = await conferirDps(input, config);
    return { resultado: ok ? 'simulada' : 'erro', msg };
  }

  // ── MODO REAL (EMITIR_REAL=1) ──
  // NÃO exercitar nos testes — requer SEFIN online.
  try {
    const { emitirNfse } = await import('./emissor.js');
    const { enviarEmailNota } = await import('./email.js');
    const resultado = await emitirNfse(input);
    // Extrai chave de acesso do retorno da lib (campo pode variar por versão)
    const chave: string =
      (resultado as Record<string, unknown>)['chNFSe'] as string ??
      (resultado as Record<string, unknown>)['chaveAcesso'] as string ??
      `SIM-${input.nDPS}-${venda.id_venda}`;

    registrarNota({
      chave_acesso: chave,
      ndps: Number(input.nDPS),
      id_venda: venda.id_venda,
      emitida_em: new Date().toISOString(),
    });

    // E-mail é efeito colateral: falha aqui não pode marcar a venda como erro,
    // a nota já está autorizada na SEFIN.
    try {
      await enviarEmailNota(venda, chave);
    } catch (err) {
      console.warn(`  E-mail falhou (nota OK): ${err}`);
    }

    return { resultado: 'emitida', msg: `chNFSe=${chave}` };
  } catch (err) {
    return { resultado: 'erro', msg: String(err) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parseia --limite N
  const args = process.argv.slice(2);
  let limite = Infinity;
  const idxLimite = args.indexOf('--limite');
  if (idxLimite !== -1 && args[idxLimite + 1]) {
    limite = parseInt(args[idxLimite + 1], 10);
    if (isNaN(limite) || limite <= 0) {
      console.error('--limite deve ser um inteiro positivo');
      process.exit(1);
    }
  }

  const db = initDb();

  // Busca vendas prontas ainda não processadas (não simulada/emitida)
  const prontas = listVendas({ fila: 'pronta' }).filter(
    (v) => v.status !== 'simulada' && v.status !== 'emitida',
  );

  // Ordena por data_venda crescente (mais antigas primeiro)
  prontas.sort((a, b) => {
    const da = a.data_venda ?? '';
    const db2 = b.data_venda ?? '';
    return da < db2 ? -1 : da > db2 ? 1 : 0;
  });

  const fila = prontas.slice(0, limite);

  if (fila.length === 0) {
    console.log('Nenhuma venda pronta para processar.');
    return;
  }

  console.log(
    `\n=== Fila NFS-e [${MODO_REAL ? 'MODO REAL ⚠️' : 'SIMULAÇÃO'}] ===`,
  );
  console.log(`Prontas na fila: ${prontas.length} | Processando: ${fila.length}\n`);

  // nDPS simulado: começa em proximoNDPS() mas NÃO persiste em notas
  const ndpsSimBase = proximoNDPS();

  const contagem = { simuladas: 0, emitidas: 0, erros: 0, puladas: 0 };
  const errosDetalhe: Array<{ id_venda: string; produto: string; erro: string }> = [];

  for (let i = 0; i < fila.length; i++) {
    const venda = fila[i];
    const ndpsSim = ndpsSimBase + i; // contador fictício local (não persiste)

    const { resultado, msg } = await processarVenda(venda, db, ndpsSim);

    marcarStatus(venda.id_venda, resultado, resultado === 'erro' ? msg : undefined);

    if (resultado === 'simulada') {
      contagem.simuladas++;
    } else if (resultado === 'emitida') {
      contagem.emitidas++;
      // Pausa entre envios reais
      if (MODO_REAL && i < fila.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      contagem.erros++;
      errosDetalhe.push({
        id_venda: venda.id_venda,
        produto: venda.produto ?? '(sem produto)',
        erro: msg,
      });
    }
  }

  // ─── Tabela-resumo ──────────────────────────────────────────────────────────
  console.log('─'.repeat(50));
  console.log('RESUMO');
  console.log('─'.repeat(50));
  if (!MODO_REAL) {
    console.log(`  Simuladas  : ${contagem.simuladas}`);
  } else {
    console.log(`  Emitidas   : ${contagem.emitidas}`);
  }
  console.log(`  Erros      : ${contagem.erros}`);
  console.log(`  Puladas    : ${contagem.puladas}`);
  console.log('─'.repeat(50));

  if (errosDetalhe.length > 0) {
    console.log('\nPrimeiros erros (máx. 5):');
    errosDetalhe.slice(0, 5).forEach((e, idx) => {
      console.log(`\n  [${idx + 1}] id_venda : ${e.id_venda}`);
      console.log(`       produto  : ${e.produto}`);
      console.log(`       erro     : ${e.erro}`);
    });
  }
}

// Só roda main() quando executado diretamente (npx tsx fila.ts) — importar o
// módulo em teste (para os helpers puros acima) não deve disparar a fila real.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}
