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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmissaoInput } from './montar-dps.js';
import { config } from './config.js';
import { conferirDps } from './dps-xml.js';
import {
  buscarNotaPorVenda,
  concluirEmissao,
  initDb,
  marcarTentativaAveriguar,
  marcarTentativaRejeitada,
  proximoNDPS,
  criarEReservarEmissao,
} from './store.js';
import type { Venda } from './store.js';
import {
  buscarChaveNoXmlPorNdps,
  classificarRespostaEmissao,
  MENSAGEM_CHAVE_A_VERIFICAR,
} from './chave-acesso.js';
import { exigirEmissaoValida, exigirIdentificadorSeguro } from './validar-emissao.js';
import { exigirLeiauteNovoPermitido } from './montar-dps.js';
import { textoErroSefin } from './diagnostico-sefin.js';
import { ErroAntesDoEnvio, ehErroAntesDoEnvio } from './emissao-erros.js';
import { comandoConciliacao } from './emitir-avulsa-helpers.js';

export { comandoConciliacao } from './emitir-avulsa-helpers.js';

interface NotaAvulsa extends Omit<EmissaoInput, 'nDPS' | 'cIndOp' | 'cClassTrib'> {
  idVenda: string;
  produto?: string;
  cIndOp?: string;
  cClassTrib?: string;
}

function carregar(path: string): NotaAvulsa {
  const nota = JSON.parse(readFileSync(path, 'utf-8')) as NotaAvulsa;
  exigirIdentificadorSeguro(nota.idVenda, 'id da Venda');
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
  const nDPS = String(proximoNDPS(config.outputDir));

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
  exigirEmissaoValida(input, { idVenda: nota.idVenda });

  // Sem --real: confere e para. Onde o municipio nao tem producao restrita,
  // esta e a unica conferencia possivel antes de a nota valer de verdade.
  if (process.env['EMITIR_REAL'] !== '1') {
    await conferir(input, nota);
    return;
  }

  exigirLeiauteNovoPermitido(config.ambiente);
  if (buscarNotaPorVenda(nota.idVenda)) {
    console.log(`Venda ${nota.idVenda} já possui Nota. Emissão não enviada.`);
    return;
  }

  const venda: Venda = {
    id_venda: nota.idVenda,
    fonte: 'avulsa',
    produto: nota.produto ?? 'avulsa',
    valor: input.vServ,
    data_venda: new Date().toISOString().slice(0, 10),
    cpf_cnpj: input.tomador.CNPJ ?? input.tomador.CPF,
    nome: input.tomador.xNome,
    ...(input.tomador.email ? { email: input.tomador.email } : {}),
    fila: 'pronta',
    status: 'pronta',
  };
  const tentativa = criarEReservarEmissao(venda, config.outputDir);
  if (!tentativa) {
    if (buscarNotaPorVenda(nota.idVenda)) {
      console.log(`Venda ${nota.idVenda} já possui Nota. Emissão não enviada.`);
      return;
    }
    throw new Error(`Venda ${nota.idVenda} não está disponível para emissão.`);
  }
  input.nDPS = String(tentativa.ndps);

  console.log(`Emitindo nDPS=${input.nDPS} para ${input.tomador.xNome} (${nota.idVenda})...`);
  // Só aqui o emissor entra: importar no topo criaria diretórios e trocaria o
  // agente HTTPS global mesmo numa conferência.
  let resultado: unknown;
  try {
    let emitirNfse: (input: EmissaoInput) => Promise<unknown>;
    try {
      ({ emitirNfse } = await import('./emissor.js'));
    } catch (err: unknown) {
      const detalhe = textoErroSefin(err) || 'erro não detalhado';
      throw new ErroAntesDoEnvio(`Falha ao carregar emissor antes do envio: ${detalhe}`, { cause: err });
    }
    resultado = await emitirNfse(input);
  } catch (err: unknown) {
    const mensagem = textoErroSefin(err) || 'Falha na emissão';
    try {
      if (ehErroAntesDoEnvio(err)) marcarTentativaRejeitada(nota.idVenda, mensagem);
      else marcarTentativaAveriguar(nota.idVenda, mensagem);
    } catch (secundario: unknown) {
      console.error(`[avulsa] Falha ao marcar resultado da emissão: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
      console.error(`Conciliação manual: ${comandoConciliacao(nota.idVenda, undefined, ehErroAntesDoEnvio(err))}`);
    }
    throw err;
  }
  let decisao: ReturnType<typeof classificarRespostaEmissao>;
  try {
    decisao = classificarRespostaEmissao(resultado);
  } catch (err: unknown) {
    const mensagem = textoErroSefin(err) || 'Falha ao classificar resposta da emissão';
    try { marcarTentativaAveriguar(nota.idVenda, mensagem); } catch (secundario: unknown) {
      console.error(`[avulsa] Falha ao marcar resposta ambígua: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
      console.error(`Conciliação manual: ${comandoConciliacao(nota.idVenda)}`);
    }
    throw err;
  }
  if (decisao.estado === 'rejeitada') {
    try { marcarTentativaRejeitada(nota.idVenda, decisao.mensagem); } catch (secundario: unknown) {
      console.error(`[avulsa] Falha ao marcar rejeição: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
      console.error(`Conciliação manual: ${comandoConciliacao(nota.idVenda, undefined, true)}`);
    }
    throw new Error(decisao.mensagem);
  }

  if (decisao.estado === 'autorizada' && decisao.codigos.length > 0) {
    console.warn(`Avisos SEFIN (nota autorizada): ${decisao.codigos.join(', ')}`);
  }
  let chave = decisao.estado === 'autorizada' ? decisao.chave : null;
  if (decisao.estado === 'sucesso_sem_chave') {
    try {
      chave = buscarChaveNoXmlPorNdps(config.outputDir, input.nDPS);
    } catch (err: unknown) {
      const detalhe = textoErroSefin(err) || 'erro não detalhado';
      const mensagem = `${MENSAGEM_CHAVE_A_VERIFICAR} Falha ao ler XML autorizado: ${detalhe}`;
      try { marcarTentativaAveriguar(nota.idVenda, mensagem); } catch (secundario: unknown) {
        console.error(`[avulsa] Falha ao marcar falha de leitura: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
        console.error(`Conciliação manual: ${comandoConciliacao(nota.idVenda)}`);
      }
      throw new Error(mensagem);
    }
  }
  if (!chave) {
    const mensagem = `${MENSAGEM_CHAVE_A_VERIFICAR} Verifique ${join(config.outputDir, 'autorizacao')}.`;
    try { marcarTentativaAveriguar(nota.idVenda, mensagem); } catch (secundario: unknown) {
      console.error(`[avulsa] Falha ao marcar Chave ausente: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
      console.error(`Conciliação manual: ${comandoConciliacao(nota.idVenda)}`);
    }
    throw new Error(mensagem);
  }

  try {
    concluirEmissao({
      chave_acesso: chave,
      ndps: Number(input.nDPS),
      id_venda: nota.idVenda,
      emitida_em: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const mensagem = textoErroSefin(err) || 'Falha ao persistir a emissão';
    try { marcarTentativaAveriguar(nota.idVenda, mensagem); } catch (secundario: unknown) {
      console.error(`[avulsa] Falha ao marcar falha de persistência: ${textoErroSefin(secundario) || 'erro não detalhado'}`);
      console.error(`Conciliação manual: ${comandoConciliacao(nota.idVenda, chave)}`);
    }
    throw err;
  }

  console.log(`AUTORIZADA. chave=${chave}`);
  console.log(`Arquivar: npx tsx arquivar-nota.ts ${nota.idVenda}`);
}

main().catch((err) => {
  console.error('FALHA na emissão:', textoErroSefin(err) || 'Falha na emissão');
  process.exit(1);
});
