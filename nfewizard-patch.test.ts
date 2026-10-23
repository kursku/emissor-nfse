import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { NFE_SchemaValidate, XmlBuilder } from '@nfewizard/shared';
import { buscarMapaFiscal, montarInput } from './fila-helpers.js';
import { montarDps } from './montar-dps.js';
import type { ConfigPrestador, EmissaoInput } from './montar-dps.js';
import { criarContrato, gerarVendasDoMes, initDb, listVendas } from './store.js';

const xsd = readFileSync(
  new URL('./node_modules/@nfewizard/shared/resources/schemas/nfse/tiposComplexos_v1.01.xsd', import.meta.url),
  'utf8',
);

test('o patch aplica o XSD novo: finNFSe e obrigatorio em TCInfDPS', () => {
  const tcInfDps = /<xs:complexType name="TCInfDPS">([\s\S]*?)<\/xs:complexType>/.exec(xsd)?.[1];
  assert.ok(tcInfDps, 'TCInfDPS ausente');
  assert.match(tcInfDps, /<xs:element name="finNFSe" type="TSRTCFinNFSe">/);
  assert.doesNotMatch(tcInfDps, /minOccurs="0"[^>]*name="finNFSe"/);
});

test('o XSD novo nao aceita finNFSe dentro de IBSCBS', () => {
  const ibscbs = /<xs:complexType name="TCRTCInfoIBSCBS">([\s\S]*?)<\/xs:complexType>/.exec(xsd)?.[1];
  assert.ok(ibscbs, 'TCRTCInfoIBSCBS ausente');
  assert.doesNotMatch(ibscbs, /name="finNFSe"/);
});

for (const bundle of ['index.cjs', 'index.mjs']) {
  test(`o bundle ${bundle} normaliza finNFSe em infDPS`, () => {
    const source = readFileSync(
      new URL(`./node_modules/@nfewizard/nfse/dist/${bundle}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /infDpsNormalizado\.finNFSe = infDps\.finNFSe/);
    assert.doesNotMatch(source, /finNFSe: ibscbs\.finNFSe/);
  });
}

test('o bundle real normaliza DPS de Contrato com endereco e complemento', async () => {
  const esmUrl = new URL('./node_modules/@nfewizard/nfse/dist/index.mjs', import.meta.url);
  const { NFSeAutorizacaoService } = await import(esmUrl.href);
  const cfg: ConfigPrestador = {
    cnpj: '11222333000181',
    im: '654321',
    codMunicipio: '3509502',
    ambiente: 2,
    regTrib: { opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 },
    pTotTribSN: 6,
  };
  const db = initDb(':memory:');
  const contratoId = criarContrato({
    cliente_doc: '52998224725',
    cliente_nome: 'CLIENTE CONTRATO',
    cliente_cmun: '3509502',
    cliente_cep: '13000000',
    cliente_rua: 'Rua Exemplo',
    cliente_numero: '100',
    cliente_complemento: 'Sala 2',
    cliente_bairro: 'Centro',
    valor: 1234.56,
    xdesc_serv: 'Servico de exemplo.',
    ctrib_nac: '080201',
    cnbs: '122051900',
    dia_do_mes: 10,
  });
  assert.equal(gerarVendasDoMes('2026-01'), 1);
  const venda = listVendas({ id_venda: `contrato-${contratoId}-2026-01` })[0];
  assert.ok(venda);
  const mapa = buscarMapaFiscal(db, venda);
  assert.ok(mapa);
  const input: EmissaoInput = montarInput(venda, mapa, '7');
  const environment = { getConfig: () => ({ nfse: { ambiente: 2 } }) } as any;
  const xmlBuilder = new XmlBuilder(environment);
  const builder = {
    gerarXml: (...args: any[]) =>
      (xmlBuilder.gerarXml as unknown as (...values: any[]) => string)(...args),
    assinarXML: (xml: string) => xml,
  };
  const service = new NFSeAutorizacaoService(environment, {}, builder as any, {}, {}, {});
  const dps = montarDps(input, cfg, new Date('2026-01-31T12:00:00Z'));
  const xml = (service as any).gerarXmlDPS({ infDps: dps.infDps });

  assert.match(xml, /<tpEmit>1<\/tpEmit><finNFSe>0<\/finNFSe><cLocEmi>3509502<\/cLocEmi>/);
  assert.match(xml, /<CPF>52998224725<\/CPF>/);
  assert.match(
    xml,
    /<endNac><cMun>3509502<\/cMun><CEP>13000000<\/CEP><\/endNac><xLgr>Rua Exemplo<\/xLgr><nro>100<\/nro><xCpl>Sala 2<\/xCpl><xBairro>Centro<\/xBairro>/,
  );
  assert.match(
    xml,
    /<cServ><cTribNac>080201<\/cTribNac><cNBS>122051900<\/cNBS><xDescServ>Servico de exemplo\.<\/xDescServ><\/cServ>/,
  );
  await assert.doesNotReject(() => NFE_SchemaValidate(xml, 'NFSe_Autorizacao'));
});

test('os bundles reais expõem o marcador do patch NT 009', async () => {
  const esmUrl = new URL('./node_modules/@nfewizard/nfse/dist/index.mjs', import.meta.url);
  const esm = await import(esmUrl.href) as { NFSE_NT009_PATCHED?: boolean };
  const cjs = createRequire(import.meta.url)('./node_modules/@nfewizard/nfse/dist/index.cjs') as {
    NFSE_NT009_PATCHED?: boolean;
  };
  assert.equal(esm.NFSE_NT009_PATCHED, true);
  assert.equal(cjs.NFSE_NT009_PATCHED, true);
});
