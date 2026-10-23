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
 *   Falha de transição ou perda do lock encerra a fila. Pausa de 1s entre envios.
 *   NÃO exercitar este modo nos testes — requer certificado + SEFIN online.
 */


import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  buscarNotaPorVenda,
  concluirEmissao,
  initDb,
  listVendas,
  listarReservasAbandonadas,
  marcarTentativaAveriguar,
  marcarTentativaRejeitada,
  marcarStatus,
  proximoNDPS,
  reservarEmissao,
} from './store.js';
import type { Venda } from './store.js';
import type { EmissaoInput } from './montar-dps.js';
import { config } from './config.js';
import { conferirDps } from './dps-xml.js';
import {
  buscarMapaFiscal,
  deveInterromperFilaAposVerificacao,
  montarInput,
} from './fila-helpers.js';
import { recusaLeiauteNovo, recusaModoReal } from './ambiente.mjs';
import { mascararDocumentos } from './mascara.js';
import { textoErroSefin } from './diagnostico-sefin.js';
import {
  buscarChaveNoXmlPorNdps,
  classificarRespostaEmissao,
  MENSAGEM_CHAVE_A_VERIFICAR,
} from './chave-acesso.js';
import { exigirEmissaoValida } from './validar-emissao.js';
import { adquirirLockFilaReal } from './fila-lock.js';
import { ErroAntesDoEnvio, ehErroAntesDoEnvio } from './emissao-erros.js';

// ─── Constantes ────────────────────────────────────────────────────────────────

const MODO_REAL = process.env['EMITIR_REAL'] === '1';
const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'output', '.fila-real.lock');

type EmitirNfse = (input: EmissaoInput, antesDoEnvio?: () => void) => Promise<unknown>;

// Simulacao nao carrega emissor.ts nem email.ts: eles criam diretorios, trocam
// o agente HTTPS global e exigem o certificado. Import dinamico no modo real.


// ─── Processamento de uma venda ───────────────────────────────────────────────

export async function processarVenda(
  venda: Venda,
  db: ReturnType<typeof initDb>,
  ndpsSimLocal: number,
  confirmarLock?: () => boolean,
  emitirNfseOverride?: EmitirNfse,
): Promise<{ resultado: 'simulada' | 'emitida' | 'a_verificar' | 'erro' | 'excecao' | 'pulada'; msg: string }> {
  // Venda de Contrato usa o mapa do próprio Contrato; importação usa mapa_produtos.
  const mapa = buscarMapaFiscal(db, venda);
  if (!mapa) {
    return {
      resultado: 'excecao',
      msg: venda.contrato_id !== undefined && venda.contrato_id !== null
        ? `Contrato ${venda.contrato_id} sem mapeamento fiscal`
        : `Produto sem mapeamento fiscal: "${venda.produto}"`,
    };
  }

  let input: EmissaoInput;
  try {
    const nDPS = MODO_REAL ? String(proximoNDPS(config.outputDir)) : String(ndpsSimLocal);
    input = montarInput(venda, mapa, nDPS);
    exigirEmissaoValida(input, { idVenda: venda.id_venda });
  } catch (err) {
    return { resultado: 'excecao', msg: textoErroSefin(err) || 'Falha ao validar a Venda' };
  }

  if (!MODO_REAL) {
    // ── SIMULAÇÃO ──
    const { ok, msg } = await conferirDps(input, config);
    return { resultado: ok ? 'simulada' : 'excecao', msg };
  }

  // ── MODO REAL (EMITIR_REAL=1) ──
  // NÃO exercitar nos testes — requer SEFIN online.
  if (!confirmarLock || !confirmarLock()) {
    throw new Error('Lock da fila real perdido; emissão interrompida sem reservar a Venda.');
  }
  const confirmar = confirmarLock;
  const tentativa = reservarEmissao(venda.id_venda, config.outputDir);
  if (!tentativa) {
    const nota = buscarNotaPorVenda(venda.id_venda);
    return {
      resultado: 'pulada',
      msg: nota ? 'Venda já possui Nota; emissão pulada.' : 'Venda não está disponível para emissão.',
    };
  }
  input = { ...input, nDPS: String(tentativa.ndps) };
  let falhaAoPersistirTransicao = false;
  try {
    let emitirNfse = emitirNfseOverride;
    if (!emitirNfse) {
      try {
        ({ emitirNfse } = await import('./emissor.js'));
      } catch (err: unknown) {
        const detalhe = textoErroSefin(err) || 'erro não detalhado';
        throw new ErroAntesDoEnvio(`Falha ao carregar emissor antes do envio: ${detalhe}`, { cause: err });
      }
    }
    const antesDoEnvio = (): void => {
      if (!confirmar()) {
        throw new ErroAntesDoEnvio('Lock da fila real perdido; emissão interrompida sem chamar o emissor.');
      }
    };
    const resultado = await emitirNfse(input, antesDoEnvio);
    const decisao = classificarRespostaEmissao(resultado);
    if (decisao.estado === 'rejeitada') {
      try { marcarTentativaRejeitada(venda.id_venda, decisao.mensagem); } catch (secundario: unknown) {
        console.error(`[fila] Falha ao marcar rejeição: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
        falhaAoPersistirTransicao = true;
        throw secundario;
      }
      return { resultado: 'erro', msg: decisao.mensagem };
    }

    if (decisao.estado === 'autorizada' && decisao.codigos.length > 0) {
      console.warn(`  Avisos SEFIN (nota autorizada): ${decisao.codigos.join(', ')}`);
    }
    let chave = decisao.estado === 'autorizada' ? decisao.chave : null;
    if (decisao.estado === 'sucesso_sem_chave') {
      try {
        chave = buscarChaveNoXmlPorNdps(config.outputDir, input.nDPS);
      } catch (err: unknown) {
        const detalhe = textoErroSefin(err) || 'erro não detalhado';
        const mensagem = `${MENSAGEM_CHAVE_A_VERIFICAR} Falha ao ler XML autorizado: ${detalhe}`;
        try { marcarTentativaAveriguar(venda.id_venda, mensagem); } catch (secundario: unknown) {
          console.error(`[fila] Falha ao marcar falha de leitura: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
          falhaAoPersistirTransicao = true;
          throw secundario;
        }
        return {
          resultado: 'a_verificar',
          msg: mensagem,
        };
      }
    }
    if (!chave) {
      try { marcarTentativaAveriguar(venda.id_venda, MENSAGEM_CHAVE_A_VERIFICAR); } catch (secundario: unknown) {
        console.error(`[fila] Falha ao marcar Chave ausente: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
        falhaAoPersistirTransicao = true;
        throw secundario;
      }
      return { resultado: 'a_verificar', msg: MENSAGEM_CHAVE_A_VERIFICAR };
    }

    concluirEmissao({
      chave_acesso: chave,
      ndps: Number(input.nDPS),
      id_venda: venda.id_venda,
      emitida_em: new Date().toISOString(),
    });

    // E-mail é efeito colateral: falha aqui não pode marcar a venda como erro,
    // a nota já está autorizada na SEFIN.
    try {
      const { enviarEmailNota } = await import('./email.js');
      await enviarEmailNota(venda, chave);
    } catch (err) {
      console.warn(`  E-mail falhou (nota OK): ${textoErroSefin(err) || 'erro não detalhado'}`);
    }

    return { resultado: 'emitida', msg: `chNFSe=${chave}` };
  } catch (err) {
    if (falhaAoPersistirTransicao) throw err;
    const mensagem = textoErroSefin(err) || 'Falha na emissão';
    try {
      if (ehErroAntesDoEnvio(err)) {
        marcarTentativaRejeitada(venda.id_venda, mensagem);
        return { resultado: 'erro', msg: mensagem };
      }
      marcarTentativaAveriguar(venda.id_venda, mensagem);
      return { resultado: 'a_verificar', msg: mensagem };
    } catch (secundario: unknown) {
      console.error(`[fila] Falha ao marcar resultado da emissão: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
      falhaAoPersistirTransicao = true;
      throw secundario;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const recusa = recusaModoReal(MODO_REAL, config.ambiente);
  if (recusa) {
    console.error(recusa);
    process.exitCode = 1;
    return;
  }
  const recusaLeiaute = recusaLeiauteNovo(MODO_REAL, config.ambiente);
  if (recusaLeiaute) {
    console.error(recusaLeiaute);
    process.exitCode = 1;
    return;
  }

  if (MODO_REAL) mkdirSync(dirname(LOCK_PATH), { recursive: true });
  const lock = MODO_REAL ? adquirirLockFilaReal(LOCK_PATH) : null;
  if (MODO_REAL && !lock) {
    console.error('Já existe uma execução real da fila em andamento; encerrando sem emitir.');
    process.exitCode = 1;
    return;
  }

  try {
    // Parseia --limite N
    const args = process.argv.slice(2);
    let limite = Infinity;
    const idxLimite = args.indexOf('--limite');
    if (idxLimite !== -1 && args[idxLimite + 1]) {
      limite = parseInt(args[idxLimite + 1], 10);
      if (isNaN(limite) || limite <= 0) {
        console.error('--limite deve ser um inteiro positivo');
        process.exitCode = 1;
        return;
      }
    }

    const db = initDb();
    if (MODO_REAL && lock) listarReservasAbandonadas();

    // Busca vendas prontas ainda não processadas (não simulada/emitida/erro)
    const prontas = listVendas({ fila: 'pronta' }).filter(
      (v) => v.status !== 'simulada' && v.status !== 'emitida' &&
        v.status !== 'erro' && v.status !== 'emitindo' && v.status !== 'a_verificar',
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

  // nDPS simulado: começa na fonte compartilhada, mas NÃO persiste em notas
  const ndpsSimBase = proximoNDPS(config.outputDir);

  const contagem = { simuladas: 0, emitidas: 0, aVerificar: 0, erros: 0, puladas: 0 };
  const errosDetalhe: Array<{ id_venda: string; produto: string; erro: string }> = [];

    for (let i = 0; i < fila.length; i++) {
      const venda = fila[i];
      const ndpsSim = ndpsSimBase + i; // contador fictício local (não persiste)

      const { resultado, msg } = await processarVenda(
        venda,
        db,
        ndpsSim,
        MODO_REAL ? () => lock?.confirmar() ?? false : undefined,
      );

      const mensagemSegura = mascararDocumentos(msg);
      if (resultado !== 'pulada') {
        marcarStatus(
          venda.id_venda,
          resultado,
          resultado === 'erro' || resultado === 'excecao' || resultado === 'a_verificar'
            ? mensagemSegura
            : undefined,
        );
      }

    if (resultado === 'a_verificar') {
      contagem.aVerificar++;
      if (deveInterromperFilaAposVerificacao(MODO_REAL, resultado)) {
        console.error(
          `  Fila interrompida: Venda ${venda.id_venda} está a verificar. ${mensagemSegura}`,
        );
        break;
      }
    } else if (resultado === 'simulada') {
      contagem.simuladas++;
    } else if (resultado === 'emitida') {
      contagem.emitidas++;
      // Pausa entre envios reais
      if (MODO_REAL && i < fila.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else if (resultado === 'pulada') {
      contagem.puladas++;
    } else {
      contagem.erros++;
      errosDetalhe.push({
        id_venda: venda.id_venda,
        produto: venda.produto ?? '(sem produto)',
        erro: mensagemSegura,
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
  console.log(`  A verificar: ${contagem.aVerificar}`);
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
  } finally {
    lock?.liberar();
  }
}

// Só roda main() quando executado diretamente (npx tsx fila.ts) — importar o
// módulo em teste (para os helpers puros acima) não deve disparar a fila real.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('Erro fatal:', textoErroSefin(err) || 'Falha fatal na fila');
    process.exit(1);
  });
}
