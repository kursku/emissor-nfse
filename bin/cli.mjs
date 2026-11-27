#!/usr/bin/env node
/**
 * cli.mjs — ponto de entrada único do emissor.
 *
 * `nfse <comando> [args]` — cada comando roda o script correspondente via tsx.
 * Funciona de qualquer pasta: os scripts resolvem `.env`, banco e saídas
 * relativos a este diretório, não ao diretório atual do terminal.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambienteFilho } from '../src/ambiente.mjs';

const BIN_DIR = import.meta.dirname;
const ROOT = join(BIN_DIR, '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const COMANDOS = {
  setup: {
    script: 'bin/setup.mjs',
    uso: 'nfse setup',
    desc: 'assistente de configuracao — cria o .env passo a passo',
  },
  check: {
    script: 'src/check-convenio.ts',
    uso: 'nfse check [cTribNac]',
    desc: 'verifica adesao do municipio ao Convenio Nacional e a aliquota vigente',
  },
  painel: {
    script: 'src/painel/server.ts',
    uso: 'nfse painel',
    desc: 'abre o painel web em http://localhost:3000',
  },
  fila: {
    script: 'src/fila.ts',
    uso: 'nfse fila [--limite N] [--real]',
    desc: 'processa a fila de vendas (simulacao por padrao; --real emite de verdade)',
  },
  emitir: {
    script: 'src/emitir-avulsa.ts',
    uso: 'nfse emitir <nota.json> --real',
    desc: 'emite uma nota avulsa a partir de um JSON (ver examples/nota-exemplo.json)',
  },
  conciliar: {
    script: 'src/conciliar.ts',
    uso: 'nfse conciliar <id_venda> --chave <chave_acesso> | --rejeitada',
    desc: 'concilia manualmente uma emissão que ficou a verificar',
  },
  importar: {
    script: 'integracoes/importar-lastlink.ts',
    uso: 'nfse importar <planilha.xlsx>',
    desc: 'importa o relatorio sales_list da Lastlink para o banco',
  },
  contratos: {
    script: 'integracoes/contratos.ts',
    uso: 'nfse contratos <criar|listar|atualizar|desativar|gerar>',
    desc: 'contratos recorrentes: cadastra uma vez, gera as vendas do mes',
  },
  arquivar: {
    script: 'src/arquivar-nota.ts',
    uso: 'nfse arquivar <id_venda>',
    desc: 'salva XML e DANFSe da nota em output/notas/<AAAA-MM>/<id_venda>/',
  },
  reenviar: {
    script: 'src/reenviar.ts',
    uso: 'nfse reenviar <id_venda> [--enviar]',
    desc: 'reenvia o e-mail da Nota (simulação por padrão; --enviar envia)',
  },
  danfse: {
    script: 'src/danfse-cli.ts',
    uso: 'nfse danfse <nota.xml> [saida.pdf]',
    desc: 'gera DANFSe local de XML autorizado, sem enviar nada',
  },
};

function ajuda() {
  console.log('Emissor NFS-e — uso: nfse <comando> [args]\n');
  for (const c of Object.values(COMANDOS)) {
    console.log(`  ${c.uso.padEnd(34)} ${c.desc}`);
  }
  console.log('\n  nfse --help                        esta mensagem');
  console.log('\nEmissao real (--real) e irreversivel: so se corrige por substituicao.');
}

/**
 * Encaminha sinais de encerramento ao processo filho e finaliza o processo pai
 * com o código de saída correspondente (ou `128 + sinal` quando morto por sinal).
 *
 * @param {import('node:child_process').ChildProcess} filho Processo filho criado por `spawn`.
 * @param {Pick<NodeJS.Process, 'on' | 'off'>} [signalTarget=process] Alvo onde registrar os sinais.
 * @param {(code: number) => void} [onExit] Callback de saída do processo pai.
 * @returns {() => void} Função para remover os listeners de sinal.
 */
export function vincularEncerramentoFilho(
  filho,
  signalTarget = process,
  onExit = (code) => process.exit(code),
) {
  /**
   * Repassa o sinal recebido ao processo filho enquanto ele ainda estiver ativo.
   *
   * @param {NodeJS.Signals} sinal Sinal recebido do sistema operacional.
   */
  const repassarSinal = (sinal) => {
    if (filho.exitCode === null && filho.signalCode === null) {
      try {
        filho.kill(sinal);
      } catch {
        // O filho pode encerrar entre a checagem e o envio do sinal.
      }
    }
  };

  const removerSinais = () => {
    signalTarget.off('SIGTERM', repassarSinal);
    signalTarget.off('SIGINT', repassarSinal);
  };

  signalTarget.on('SIGTERM', repassarSinal);
  signalTarget.on('SIGINT', repassarSinal);

  filho.on('exit', (code, signal) => {
    removerSinais();
    if (code !== null) {
      onExit(code);
      return;
    }
    const num = signal ? osConstants.signals[signal] : undefined;
    onExit(typeof num === 'number' ? 128 + num : 1);
  });

  return removerSinais;
}

/**
 * Verifica se este script foi executado diretamente pela CLI (e não importado em teste).
 *
 * @returns {boolean} `true` quando `process.argv[1]` aponta para este arquivo.
 */
function ehExecucaoDireta() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (ehExecucaoDireta()) {
  const [comando, ...resto] = process.argv.slice(2);

  if (!comando || comando === '--help' || comando === '-h' || comando === 'help') {
    ajuda();
    process.exit(comando ? 0 : 1);
  }

  const alvo = COMANDOS[comando];
  if (!alvo) {
    console.error(`Comando desconhecido: "${comando}". Rode "nfse --help".`);
    process.exit(1);
  }

  // setup.mjs roda com node puro — precisa funcionar antes do npm install.
  const precisaTsx = alvo.script.endsWith('.ts');
  if (precisaTsx && !existsSync(TSX)) {
    console.error(`Dependencias nao instaladas. Rode "npm ci" e "npm run patch:apply" em ${ROOT}.`);
    process.exit(1);
  }

  // --real vira EMITIR_REAL=1 e nao e repassado ao script; sem a flag, 0 vence
  // qualquer valor herdado do ambiente do operador.
  const real = resto.includes('--real');
  const args = resto.filter((a) => a !== '--real');

  const alvoPath = join(ROOT, alvo.script);
  const filho = spawn(process.execPath, precisaTsx ? [TSX, alvoPath, ...args] : [alvoPath, ...args], {
    stdio: 'inherit',
    env: ambienteFilho(process.env, real),
  });
  vincularEncerramentoFilho(filho);
}
