#!/usr/bin/env node
/**
 * setup.mjs — assistente de configuração interativo.
 *
 * `nfse setup` (ou `node setup.mjs`). Pergunta um item por vez, valida cada
 * resposta e escreve o `.env`. Roda sem dependências: só Node >= 20.12.
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cnpjInvalido, codMunicipioInvalido } from './validacoes.mjs';

const BASE = import.meta.dirname;
const ENV_PATH = join(BASE, '.env');

// ── cores ─────────────────────────────────────────────────────────────────────
const cor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = {
  reset: cor ? '\x1b[0m' : '',
  dim: cor ? '\x1b[2m' : '',
  bold: cor ? '\x1b[1m' : '',
  ciano: cor ? '\x1b[36m' : '',
  verde: cor ? '\x1b[32m' : '',
  amarelo: cor ? '\x1b[33m' : '',
  vermelho: cor ? '\x1b[31m' : '',
};

const BANNER = `${c.ciano}
   ███╗   ██╗███████╗███████╗      ███████╗
   ████╗  ██║██╔════╝██╔════╝      ██╔════╝
   ██╔██╗ ██║█████╗  ███████╗█████╗█████╗
   ██║╚██╗██║██╔══╝  ╚════██║╚════╝██╔══╝
   ██║ ╚████║██║     ███████║      ███████╗
   ╚═╝  ╚═══╝╚═╝     ╚══════╝      ╚══════╝${c.reset}
   ${c.dim}emissor de nota fiscal de servico — padrao nacional${c.reset}
`;

function titulo(n, total, texto) {
  console.log(`\n${c.ciano}${'─'.repeat(64)}${c.reset}`);
  console.log(`${c.bold}  ${n}/${total}  ${texto}${c.reset}`);
  console.log(`${c.ciano}${'─'.repeat(64)}${c.reset}`);
}

const dica = (t) => console.log(`${c.dim}   ${t}${c.reset}`);
const ok = (t) => console.log(`${c.verde}   ✓ ${t}${c.reset}`);
const erro = (t) => console.log(`${c.vermelho}   ✗ ${t}${c.reset}`);
const alerta = (t) => console.log(`${c.amarelo}   ! ${t}${c.reset}`);

// ── perguntas ─────────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const escrevePadrao = process.stdout.write.bind(process.stdout);

async function perguntar(texto, { padrao, secreto = false, valida } = {}) {
  const sufixo = padrao !== undefined && padrao !== '' ? `${c.dim} [${padrao}]${c.reset}` : '';
  for (;;) {
    const p = rl.question(`\n   ${texto}${sufixo}\n   ${c.ciano}>${c.reset} `);
    // Silencia o eco enquanto a senha e digitada — nao aparece na tela nem no
    // scrollback do terminal. Restaurado logo apos a resposta.
    if (secreto) process.stdout.write = () => true;
    let v = (await p).trim();
    if (secreto) {
      process.stdout.write = escrevePadrao;
      process.stdout.write('\n');
    }
    if (!v && padrao !== undefined) v = String(padrao);
    if (!valida) return v;
    const problema = valida(v);
    if (!problema) return v;
    erro(problema);
  }
}

async function escolher(texto, opcoes, padrao = 1) {
  console.log(`\n   ${texto}`);
  opcoes.forEach((o, i) => console.log(`     ${c.ciano}${i + 1}${c.reset}) ${o.label}`));
  const v = await perguntar('Numero da opcao', {
    padrao,
    valida: (x) => {
      const n = Number(x);
      return Number.isInteger(n) && n >= 1 && n <= opcoes.length
        ? null
        : `Escolha um numero entre 1 e ${opcoes.length}.`;
    },
  });
  return opcoes[Number(v) - 1].valor;
}

const confirmar = async (texto, padrao = 's') =>
  (await perguntar(`${texto} (s/n)`, { padrao })).toLowerCase().startsWith('s');

// ── validacoes ────────────────────────────────────────────────────────────────
const semAcento = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Busca o codigo IBGE pelo nome da cidade. Lista os municipios da UF e filtra
 * local: o parametro `?nome=` da API do IBGE nao filtra de verdade.
 * Falha de rede vira entrada manual do codigo.
 */
async function buscarMunicipio(nome, uf) {
  const url = `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`IBGE HTTP ${res.status}`);
  const lista = await res.json();
  const alvo = semAcento(nome);
  const achados = lista
    .filter((m) => semAcento(m.nome) === alvo)
    .map((m) => ({ id: String(m.id), nome: m.nome }));
  if (achados.length > 0) return achados; // nome exato ganha do parcial
  return lista
    .filter((m) => semAcento(m.nome).includes(alvo))
    .map((m) => ({ id: String(m.id), nome: m.nome }));
}

// ── passos ────────────────────────────────────────────────────────────────────
const TOTAL = 6;

async function main() {
  console.log(BANNER);

  const [maior, menor] = process.versions.node.split('.').map(Number);
  if (maior < 20 || (maior === 20 && menor < 12)) {
    erro(`Node ${process.versions.node} — este projeto precisa da versao 20.12 ou maior.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);
  if (!existsSync(join(BASE, 'node_modules'))) {
    alerta('Dependencias ainda nao instaladas — rode "npm install" depois do setup.');
  } else {
    ok('Dependencias instaladas');
  }

  if (existsSync(ENV_PATH)) {
    alerta('Ja existe um arquivo .env nesta pasta.');
    if (!(await confirmar('Sobrescrever a configuracao atual?', 'n'))) {
      console.log(`\n${c.dim}   Setup cancelado. Nada foi alterado.${c.reset}\n`);
      rl.close();
      return;
    }
  }

  // 1. empresa
  titulo(1, TOTAL, 'Sua empresa');
  dica('Dados que vao na nota como prestador do servico.');
  const cnpj = (await perguntar('CNPJ da empresa', { valida: cnpjInvalido })).replace(/\D/g, '');
  const im = await perguntar('Inscricao Municipal (IM) na prefeitura', {
    valida: (v) => (v ? null : 'Obrigatorio — esta no alvara ou no cadastro mobiliario.'),
  });
  const uf = (
    await perguntar('UF do municipio (ex.: SP)', {
      valida: (v) => (/^[A-Za-z]{2}$/.test(v) ? null : 'Duas letras, ex.: SP.'),
    })
  ).toUpperCase();

  // 2. municipio
  titulo(2, TOTAL, 'Municipio');
  dica('O codigo IBGE tem 7 digitos e identifica a cidade na nota.');
  let codMun = '';
  const cidade = await perguntar(`Nome da cidade em ${uf} (vazio para digitar o codigo)`, {
    padrao: '',
  });
  if (cidade) {
    try {
      const achados = await buscarMunicipio(cidade, uf);
      if (achados.length === 1) {
        codMun = achados[0].id;
        ok(`${achados[0].nome}/${uf} — codigo ${codMun}`);
      } else if (achados.length > 1 && achados.length <= 12) {
        codMun = await escolher(
          'Mais de uma cidade encontrada:',
          achados.map((m) => ({ label: `${m.nome}/${uf} (${m.id})`, valor: m.id })),
        );
      } else if (achados.length > 12) {
        alerta(`${achados.length} cidades combinam com "${cidade}" — escreva o nome completo.`);
      } else {
        alerta(`Nenhuma cidade "${cidade}" em ${uf}.`);
      }
    } catch (err) {
      alerta(`Consulta ao IBGE falhou (${err.message}). Digite o codigo manualmente.`);
    }
  }
  if (!codMun) {
    codMun = await perguntar('Codigo IBGE do municipio (7 digitos)', {
      valida: codMunicipioInvalido,
    });
  }

  // 3. certificado
  titulo(3, TOTAL, 'Certificado digital');
  dica('Arquivo A1 e-CNPJ (.p12 ou .pfx). Token/cartao A3 nao serve para automacao.');
  const certPath = (
    await perguntar('Caminho completo do arquivo', {
      valida: (v) =>
        existsSync(v.replace(/^"|"$/g, '')) ? null : 'Arquivo nao encontrado nesse caminho.',
    })
  ).replace(/^"|"$/g, '');
  const certPass = await perguntar('Senha do certificado (nao aparece na tela)', {
    secreto: true,
    valida: (v) => (v ? null : 'A senha e obrigatoria.'),
  });
  ok('Senha registrada');

  // 4. tributacao
  titulo(4, TOTAL, 'Regime tributario');
  dica('Na duvida, confirme com seu contador — isso muda o calculo da nota.');
  const opSimpNac = await escolher(
    'Sua empresa e:',
    [
      { label: 'Simples Nacional ME/EPP', valor: '3' },
      { label: 'MEI', valor: '2' },
      { label: 'Nao optante pelo Simples', valor: '1' },
    ],
    1,
  );
  let regAp = '1';
  if (opSimpNac === '3') {
    regAp = await escolher(
      'Regime de apuracao no Simples:',
      [
        { label: 'Federais e municipal pelo Simples (mais comum)', valor: '1' },
        { label: 'Federais pelo Simples e ISS por fora', valor: '2' },
        { label: 'Federais pelo Simples e ISS fixo', valor: '3' },
      ],
      1,
    );
  }
  const anexo = await escolher(
    'Anexo do Simples do seu servico (define o % de tributos na nota):',
    [
      { label: 'Anexo III — 6,00%', valor: '6.00' },
      { label: 'Anexo V — 15,50%', valor: '15.50' },
      { label: 'Outro — digitar o percentual', valor: 'outro' },
    ],
    1,
  );
  const pTot =
    anexo !== 'outro'
      ? anexo
      : await perguntar('Percentual (ex.: 11.20)', {
          valida: (x) => (/^\d{1,2}(\.\d{1,2})?$/.test(x) ? null : 'Use ponto, ex.: 11.20.'),
        });

  // 5. ambiente
  titulo(5, TOTAL, 'Ambiente de emissao');
  alerta('Nota emitida em producao e um documento oficial e irreversivel.');
  const ambiente = await escolher(
    'Comecar em qual ambiente?',
    [
      { label: 'Producao restrita — para testar sem valor fiscal (recomendado)', valor: '2' },
      { label: 'Producao — emite notas de verdade', valor: '1' },
    ],
    1,
  );

  // 6. e-mail
  titulo(6, TOTAL, 'Envio por e-mail (opcional)');
  dica('Manda o PDF da nota para o cliente automaticamente, via Resend.');
  let resendKey = '';
  let resendFrom = '';
  if (await confirmar('Configurar agora?', 'n')) {
    resendKey = await perguntar('RESEND_API_KEY', { secreto: true });
    resendFrom = await perguntar('E-mail remetente (ex.: notas@seudominio.com.br)');
  }

  // ── grava ───────────────────────────────────────────────────────────────────
  const env = `# Gerado por "nfse setup". Este arquivo tem segredos: nunca versionar.

# Prestador
NFSE_CNPJ=${cnpj}
NFSE_IM=${im}
NFSE_UF=${uf}
NFSE_COD_MUNICIPIO=${codMun}

# Certificado A1 e-CNPJ
NFSE_CERT_PATH=${certPath.replace(/\\/g, '/')}
NFSE_CERT_PASSWORD=${certPass}

# 1 = producao (irreversivel) | 2 = producao restrita
NFSE_AMBIENTE=${ambiente}
NFSE_OUTPUT_DIR=

# Tributacao
NFSE_OP_SIMP_NAC=${opSimpNac}
NFSE_REG_AP_TRIB_SN=${regAp}
NFSE_REG_ESP_TRIB=0
NFSE_P_TOT_TRIB_SN=${pTot}

# E-mail (Resend)
RESEND_API_KEY=${resendKey}
RESEND_FROM_NOTAS=${resendFrom}
`;
  writeFileSync(ENV_PATH, env, 'utf-8');

  console.log(`\n${c.verde}${'═'.repeat(64)}${c.reset}`);
  console.log(`${c.bold}${c.verde}   Configuracao salva em .env${c.reset}`);
  console.log(`${c.verde}${'═'.repeat(64)}${c.reset}\n`);
  console.log(`   CNPJ ................ ${cnpj}`);
  console.log(`   Inscricao Municipal . ${im}`);
  console.log(`   Municipio ........... ${codMun} (${uf})`);
  console.log(`   Certificado ......... ${certPath}`);
  console.log(`   Senha ............... ${'*'.repeat(8)}`);
  console.log(
    `   Ambiente ............ ${ambiente === '1' ? `${c.amarelo}PRODUCAO (notas reais)${c.reset}` : 'producao restrita'}`,
  );
  console.log(`   Tributos na nota .... ${pTot}%\n`);

  console.log(`${c.bold}   Proximos passos:${c.reset}`);
  if (!existsSync(join(BASE, 'node_modules'))) console.log(`     ${c.ciano}npm install${c.reset}`);
  console.log(`     ${c.ciano}nfse check${c.reset}             verifica se seu municipio aceita o padrao nacional`);
  console.log(`     ${c.ciano}nfse fila --limite 5${c.reset}   simula, sem emitir nada`);
  console.log(`     ${c.ciano}nfse --help${c.reset}            todos os comandos\n`);

  rl.close();
}

main().catch((err) => {
  erro(err instanceof Error ? err.message : String(err));
  rl.close();
  process.exit(1);
});
