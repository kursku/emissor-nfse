/**
 * Testes dos helpers puros de fila-helpers.ts: montarInput (mapeamento Venda
 * -> EmissaoInput) e buscarMapaProduto (lookup em mapa_produtos). Testado via
 * fila-helpers.ts diretamente — importar fila.ts puxa config.ts, que exige
 * NFSE_* no ambiente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  montarInput,
  buscarMapaProduto,
  buscarMapaFiscal,
  deveInterromperFilaAposVerificacao,
} from "./fila-helpers.js";
import { criarContrato, gerarVendasDoMes, initDb, listVendas } from "./store.js";
import type { Venda } from "./store.js";
import { exigirEmissaoValida } from "./validar-emissao.js";
import { recusaLeiauteNovo } from "./ambiente.mjs";
import { montarDps } from "./montar-dps.js";
import type { ConfigPrestador } from "./montar-dps.js";

const MAPA = { ctrib_nac: "080201", cnbs: "122051900", xdesc_serv: "Servico de exemplo." };
const CFG: ConfigPrestador = {
  cnpj: "11222333000181",
  im: "654321",
  codMunicipio: "3509502",
  ambiente: 2,
  regTrib: { opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 },
  pTotTribSN: 6,
};

function vendaBase(overrides: Partial<Venda> = {}): Venda {
  return {
    id_venda: "venda-1",
    nome: "EMPRESA EXEMPLO LTDA",
    valor: 1234.56,
    ...overrides,
  };
}

test("fila real interrompe no primeiro a_verificar para não reutilizar o nDPS", () => {
  assert.equal(deveInterromperFilaAposVerificacao(true, "a_verificar"), true);
  assert.equal(deveInterromperFilaAposVerificacao(true, "emitida"), false);
  assert.equal(deveInterromperFilaAposVerificacao(false, "a_verificar"), false);
});

test("fila real recusa o leiaute antes de abrir o banco ou tocar em Venda", () => {
  assert.match(
    recusaLeiauteNovo(true, 1, new Date("2026-12-01T02:59:59Z")) ?? "",
    /NFSE_AMBIENTE=1.*2026-12-01/,
  );
  assert.equal(recusaLeiauteNovo(true, 1, new Date("2026-12-01T03:00:00Z")), null);

  const source = readFileSync(new URL("./fila.ts", import.meta.url), "utf8");
  const guard = source.indexOf("recusaLeiauteNovo(MODO_REAL, config.ambiente");
  const openDb = source.indexOf("const db = initDb()");
  const list = source.indexOf("listVendas({ fila: 'pronta' })");
  assert.ok(guard >= 0 && guard < openDb && guard < list);
});

test("fila finaliza a Nota antes de carregar o e-mail", () => {
  const source = readFileSync(new URL("./fila.ts", import.meta.url), "utf8");
  const registro = source.indexOf("concluirEmissao({");
  const importEmail = source.indexOf("await import('./email.js')");

  assert.ok(registro >= 0);
  assert.ok(importEmail > registro);
});

test("fila e emissão avulsa usam diagnóstico seguro nos erros", () => {
  const fila = readFileSync(new URL("./fila.ts", import.meta.url), "utf8");
  const avulsa = readFileSync(new URL("./emitir-avulsa.ts", import.meta.url), "utf8");

  assert.match(fila, /textoErroSefin\(err\)/);
  assert.doesNotMatch(fila, /String\(err\)/);
  assert.match(avulsa, /textoErroSefin\(err\)/);
  assert.doesNotMatch(avulsa, /String\((err|secundario)\)/);
  assert.doesNotMatch(avulsa, /FALHA na emissão:', err/);
});

function executarFila(script: string, outputDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EMITIR_REAL: "1",
      NFSE_CNPJ: "11444777000161",
      NFSE_COD_MUNICIPIO: "3509502",
      NFSE_CERT_PATH: join(outputDir, "inexistente.p12"),
      NFSE_CERT_PASSWORD: "teste",
      NFSE_IM: "1",
      NFSE_UF: "SP",
      NFSE_AMBIENTE: "2",
      NFSE_OUTPUT_DIR: outputDir,
    },
  });
}

test("fila não reserva Venda quando o fencing falha antes da reserva", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nfse-fila-fencing-"));
  const result = executarFila(`
    const { initDb, listVendas, upsertVenda } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    db.prepare('INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)')
      .run('produto-teste', '080201', '122051900', 'Servico');
    upsertVenda({ id_venda: 'venda-fencing', produto: 'produto-teste', valor: 100,
      cpf_cnpj: '11444777000161', nome: 'Tomador', cep: '13000000', cidade: 'Campinas', uf: 'SP',
      cmun: '3509502', rua: 'Rua', numero: '1', bairro: 'Centro', fila: 'pronta', status: 'pronta' });
    const venda = listVendas({ id_venda: 'venda-fencing' })[0];
    try {
      await processarVenda(venda, db, 1, () => false, async () => ({ chNFSe: '1'.repeat(50) }));
    } catch (erro) {
      console.log(JSON.stringify({ erro: String(erro), tentativas: Number((db.prepare('SELECT COUNT(*) AS n FROM tentativas_emissao').get()).n),
        venda: listVendas({ id_venda: 'venda-fencing' })[0] }));
    }
  `, outputDir);
  rmSync(outputDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saida = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(saida.tentativas, 0);
  assert.equal(saida.venda.status, "pronta");
});

test("fila encerra com código 1 quando a transição da tentativa não muda", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nfse-fila-transicao-"));
  const result = executarFila(`
    const { initDb, listVendas, upsertVenda } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    db.prepare('INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)')
      .run('produto-teste', '080201', '122051900', 'Servico');
    upsertVenda({ id_venda: 'venda-transicao', produto: 'produto-teste', valor: 100,
      cpf_cnpj: '11444777000161', nome: 'Tomador', cep: '13000000', cidade: 'Campinas', uf: 'SP',
      cmun: '3509502', rua: 'Rua', numero: '1', bairro: 'Centro', fila: 'pronta', status: 'pronta' });
    const venda = listVendas({ id_venda: 'venda-transicao' })[0];
    await processarVenda(venda, db, 1, () => true, async (_input, antesDoEnvio) => {
      antesDoEnvio?.();
      db.prepare("UPDATE tentativas_emissao SET estado = 'a_verificar' WHERE id_venda = ?").run('venda-transicao');
      db.prepare("UPDATE vendas SET status = 'a_verificar', fila = NULL WHERE id_venda = ?").run('venda-transicao');
      return { codigo: 'E0116' };
    });
  `, outputDir);
  rmSync(outputDir, { recursive: true, force: true });

  if (result.status !== 1) throw new Error(`status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /transição da tentativa/i);
});

test("fila não grava corpo pessoal da SEFIN na Venda nem no console", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nfse-fila-diagnostico-"));
  const result = executarFila(`
    const { initDb, listVendas, upsertVenda } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    db.prepare('INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)')
      .run('produto-teste', '080201', '122051900', 'Servico');
    upsertVenda({ id_venda: 'venda-diagnostico', produto: 'produto-teste', valor: 100,
      cpf_cnpj: '11444777000161', nome: 'Tomador', cep: '13000000', cidade: 'Campinas', uf: 'SP',
      cmun: '3509502', rua: 'Rua', numero: '1', bairro: 'Centro', fila: 'pronta', status: 'pronta' });
    const corpo = { nome: 'Fulano', endereco: 'Rua X', email: 'a@b.com' };
    const erro = Object.assign(new Error('HTTP 400: ' + JSON.stringify(corpo)), {
      nfseErrorDetail: { raw: corpo },
    });
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args.map(String).join(' '));
    try {
      const venda = listVendas({ id_venda: 'venda-diagnostico' })[0];
      const resultado = await processarVenda(venda, db, 1, () => true, async () => { throw erro; });
      console.log(JSON.stringify({ resultado, venda: listVendas({ id_venda: 'venda-diagnostico' })[0], logs }));
    } finally {
      console.error = originalError;
    }
  `, outputDir);
  rmSync(outputDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saida = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(saida.resultado.resultado, "a_verificar");
  assert.doesNotMatch(JSON.stringify(saida.venda), /Fulano|Rua X|a@b\.com/);
  assert.doesNotMatch(JSON.stringify(saida.logs), /Fulano|Rua X|a@b\.com/);
});

test("fila mostra a mensagem do validador para CEP inválido", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nfse-fila-validacao-"));
  const result = executarFila(`
    const { initDb, listVendas, upsertVenda } = await import('./src/store.ts');
    const { processarVenda } = await import('./src/fila.ts');
    const db = initDb(':memory:');
    db.prepare('INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)')
      .run('produto-teste', '080201', '122051900', 'Servico');
    upsertVenda({ id_venda: 'venda-cep-invalido', produto: 'produto-teste', valor: 100,
      cpf_cnpj: '11444777000161', nome: 'Tomador', cep: '123', cidade: 'Campinas', uf: 'SP',
      cmun: '3509502', rua: 'Rua', numero: '1', bairro: 'Centro', fila: 'pronta', status: 'pronta' });
    const venda = listVendas({ id_venda: 'venda-cep-invalido' })[0];
    const resultado = await processarVenda(venda, db, 1, () => true, async () => ({}));
    console.log(JSON.stringify(resultado));
  `, outputDir);
  rmSync(outputDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const resultado = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(resultado.resultado, "excecao");
  assert.match(resultado.msg, /CEP precisa ter 8 digitos/);
});

test("montarInput usa CNPJ quando o documento tem 14 digitos", () => {
  const input = montarInput(vendaBase({ cpf_cnpj: "11.444.777/0001-61" }), MAPA, "7");
  assert.equal(input.tomador.CNPJ, "11444777000161");
  assert.equal("CPF" in input.tomador, false);
});

test("montarInput usa CPF quando o documento tem 11 digitos", () => {
  const input = montarInput(vendaBase({ cpf_cnpj: "111.444.777-35" }), MAPA, "7");
  assert.equal(input.tomador.CPF, "11144477735");
  assert.equal("CNPJ" in input.tomador, false);
});

test("fila recusa CPF com tamanho certo mas dígito inválido, inclusive Venda de Contrato", () => {
  const input = montarInput(
    vendaBase({ id_venda: "contrato-8-2026-10", cpf_cnpj: "11111111111" }),
    MAPA,
    "7",
  );
  assert.throws(
    () => exigirEmissaoValida(input, { idVenda: "contrato-8-2026-10" }),
    /Documento do Tomador inválido.*repetidos/,
  );
});

test("montarInput recusa documento com tamanho invalido", () => {
  assert.throws(
    () => montarInput(vendaBase({ cpf_cnpj: "123" }), MAPA, "7"),
    /Documento inválido para id_venda=venda-1/,
  );
});

test("montarInput nao expoe o documento completo na mensagem de erro", () => {
  assert.throws(
    () => montarInput(vendaBase({ cpf_cnpj: "11.444.777/0001-612" }), MAPA, "7"),
    (err: unknown) => {
      const mensagem = String(err);
      assert.match(mensagem, /114\.\.\.12/);
      assert.doesNotMatch(mensagem, /11\.444\.777\/0001-612|114447770001612/);
      return true;
    },
  );
});

test("montarInput inclui endereco so quando todos os campos estao presentes", () => {
  const completo = montarInput(
    vendaBase({
      cpf_cnpj: "11444777000161",
      cmun: "3509502",
      cep: "13400-000",
      rua: "Rua Exemplo",
      numero: "100",
      bairro: "Centro",
    }),
    MAPA,
    "7",
  );
  assert.deepEqual(completo.tomador.end, {
    cMun: "3509502",
    CEP: "13400000",
    xLgr: "Rua Exemplo",
    nro: "100",
    xBairro: "Centro",
  });
});

test("montarInput omite endereco inteiro quando falta qualquer campo", () => {
  const semBairro = montarInput(
    vendaBase({
      cpf_cnpj: "11444777000161",
      cmun: "3509502",
      cep: "13400-000",
      rua: "Rua Exemplo",
      numero: "100",
      // bairro ausente
    }),
    MAPA,
    "7",
  );
  assert.equal("end" in semBairro.tomador, false);
});

test("montarInput inclui email so quando presente na venda", () => {
  const comEmail = montarInput(
    vendaBase({ cpf_cnpj: "11444777000161", email: "cliente@exemplo.com.br" }),
    MAPA,
    "7",
  );
  assert.equal(comEmail.tomador.email, "cliente@exemplo.com.br");

  const semEmail = montarInput(vendaBase({ cpf_cnpj: "11444777000161" }), MAPA, "7");
  assert.equal("email" in semEmail.tomador, false);
});

test("montarInput mapeia nDPS, valor e codigos fiscais do mapa de produto", () => {
  const input = montarInput(
    vendaBase({ cpf_cnpj: "11444777000161", valor: 500 }),
    MAPA,
    "42",
  );
  assert.equal(input.nDPS, "42");
  assert.equal(input.vServ, 500);
  assert.equal(input.xDescServ, MAPA.xdesc_serv);
  assert.equal(input.cTribNac, MAPA.ctrib_nac);
  assert.equal(input.cNBS, MAPA.cnbs);
  assert.equal(input.cIndOp, "100301");
  assert.equal(input.cClassTrib, "000001");
});

test("buscarMapaProduto retorna os codigos fiscais cadastrados", () => {
  const db = initDb(":memory:");
  db.prepare(
    "INSERT INTO mapa_produtos (produto, ctrib_nac, cnbs, xdesc_serv) VALUES (?, ?, ?, ?)",
  ).run("produto-teste", "080201", "122051900", "Servico de exemplo.");

  const mapa = buscarMapaProduto(db, "produto-teste");
  assert.deepEqual({ ...mapa }, { ctrib_nac: "080201", cnbs: "122051900", xdesc_serv: "Servico de exemplo." });
});

test("buscarMapaProduto retorna null para produto sem mapeamento", () => {
  const db = initDb(":memory:");
  assert.equal(buscarMapaProduto(db, "produto-desconhecido"), null);
});

test("Vendas de Contrato com mesma descrição usam o mapa fiscal do próprio Contrato", () => {
  const db = initDb(":memory:");
  const base = {
    cliente_doc: "11444777000161",
    cliente_nome: "EMPRESA EXEMPLO LTDA",
    cliente_cmun: "3509502",
    cliente_cep: "13000000",
    cliente_rua: "Rua Exemplo",
    cliente_numero: "100",
    cliente_complemento: "Sala 2",
    cliente_bairro: "Centro",
    valor: 500,
    xdesc_serv: "Descricao igual.",
    dia_do_mes: 10,
  };
  const idA = criarContrato({ ...base, ctrib_nac: "080201", cnbs: "122051900" });
  const idB = criarContrato({
    ...base,
    cliente_nome: "OUTRA EMPRESA LTDA",
    ctrib_nac: "170501",
    cnbs: "101010101",
  });
  assert.equal(gerarVendasDoMes("2026-07"), 2);

  const vendas = listVendas().filter((v) => v.fonte === "contrato");
  for (const venda of vendas) {
    const mapa = buscarMapaFiscal(db, venda);
    assert.ok(mapa);
    const input = montarInput(venda, mapa, "7");
    const dps = montarDps(input, CFG, new Date("2026-07-10T12:00:00Z"));
    const esperado = venda.contrato_id === idA
      ? { cTribNac: "080201", cNBS: "122051900" }
      : { cTribNac: "170501", cNBS: "101010101" };
    assert.equal(dps.infDps.serv.cServ.cTribNac, esperado.cTribNac);
    assert.equal(dps.infDps.serv.cServ.cNBS, esperado.cNBS);
    assert.equal(dps.infDps.toma.end?.xCpl, "Sala 2");
  }
});
