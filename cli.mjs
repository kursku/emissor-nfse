#!/usr/bin/env node
/**
 * cli.mjs — ponto de entrada único do emissor.
 *
 * `nfse <comando> [args]` — cada comando roda o script correspondente via tsx.
 * Funciona de qualquer pasta: os scripts resolvem `.env`, banco e saídas
 * relativos a este diretório, não ao diretório atual do terminal.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = import.meta.dirname;
const TSX = join(BASE, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const COMANDOS = {
  setup: {
    script: 'setup.mjs',
    uso: 'nfse setup',
    desc: 'assistente de configuracao — cria o .env passo a passo',
  },
  check: {
    script: 'check-convenio.ts',
    uso: 'nfse check [cTribNac]',
    desc: 'verifica adesao do municipio ao Convenio Nacional e a aliquota vigente',
  },
  painel: {
    script: 'server.ts',
    uso: 'nfse painel',
    desc: 'abre o painel web em http://localhost:3000',
  },
  fila: {
    script: 'fila.ts',
    uso: 'nfse fila [--limite N] [--real]',
    desc: 'processa a fila de vendas (simulacao por padrao; --real emite de verdade)',
  },
  emitir: {
    script: 'emitir-avulsa.ts',
    uso: 'nfse emitir <nota.json> --real',
    desc: 'emite uma nota avulsa a partir de um JSON (ver nota-exemplo.json)',
  },
  importar: {
    script: 'integracoes/importar-lastlink.ts',
    uso: 'nfse importar <planilha.xlsx>',
    desc: 'importa o relatorio sales_list da Lastlink para o banco',
  },
  contratos: {
    script: 'integracoes/contratos.ts',
    uso: 'nfse contratos <criar|listar|desativar|gerar>',
    desc: 'contratos recorrentes: cadastra uma vez, gera as vendas do mes',
  },
  arquivar: {
    script: 'arquivar-nota.ts',
    uso: 'nfse arquivar <id_venda>',
    desc: 'salva XML e DANFSe da nota em output/notas/<AAAA-MM>/<id_venda>/',
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
  console.error(`Dependencias nao instaladas. Rode "npm install" em ${BASE}.`);
  process.exit(1);
}

// --real vira EMITIR_REAL=1 e nao e repassado ao script.
const real = resto.includes('--real');
const args = resto.filter((a) => a !== '--real');
if (real) console.log('MODO REAL: a nota sera emitida de verdade na SEFIN.\n');

const alvoPath = join(BASE, alvo.script);
const filho = spawn(process.execPath, precisaTsx ? [TSX, alvoPath, ...args] : [alvoPath, ...args], {
  stdio: 'inherit',
  env: real ? { ...process.env, EMITIR_REAL: '1' } : process.env,
});
filho.on('exit', (code) => process.exit(code ?? 1));
