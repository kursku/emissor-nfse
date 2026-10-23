/**
 * dps-xml.ts — gera o XML da DPS sem assinar e valida contra o XSD oficial.
 *
 * Sem rede e sem certificado: e a unica forma de conferir uma nota antes de
 * emitir onde o municipio nao tem producao restrita — nesses municipios a
 * primeira emissao ja e documento fiscal, entao nao existe ensaio.
 *
 * Usado pela fila (modo simulacao) e pelo `nfse emitir` sem `--real`.
 */
import xml2js from 'xml2js';
import { NFE_SchemaValidate } from '@nfewizard/shared';

import { montarDps } from './montar-dps.js';
import type { ConfigPrestador, EmissaoInput } from './montar-dps.js';

/** Chave usada pelo getSchema() da lib para achar o DPS_v1.01.xsd. */
const METODO_SCHEMA = 'NFSe_Autorizacao';
const SERIE_RE = /^0{0,4}\d{1,5}$/;

/**
 * A lib (>= 1.0.7) não recebe CST: deriva dos 3 primeiros dígitos do
 * cClassTrib ao montar o XML (NFSeAutorizacaoService.derivarCstDoClassTrib).
 * O XSD novo deixa CST e cClassTrib diretamente em trib.
 */
function derivarCstComoALib(infDPS: Record<string, unknown>): void {
  const ibscbs = infDPS['IBSCBS'] as { valores?: { trib?: { gIBSCBS?: Record<string, unknown> } } } | undefined;
  const trib = ibscbs?.valores?.trib as Record<string, unknown> | undefined;
  const g = trib?.['gIBSCBS'] as Record<string, unknown> | undefined;
  if (!trib || !g || typeof g['cClassTrib'] !== 'string' || 'CST' in g) return;
  delete trib['gIBSCBS'];
  trib['CST'] = g['cClassTrib'].slice(0, 3);
  trib['cClassTrib'] = g['cClassTrib'];
}

/**
 * Replica a logica de NFSeAutorizacaoService.gerarXml:
 *   - objeto com $ = { versao, xmlns } + infDPS
 *   - xml2js.Builder com rootName='DPS', headless=true
 *   - declaracao UTF-8 prefixada
 */
export function gerarXmlDps(
  input: EmissaoInput,
  cfg: ConfigPrestador,
  agora?: Date,
): string {
  const dps = montarDps(input, cfg, agora);
  const infDPSObject: Record<string, unknown> = { ...dps.infDps };
  derivarCstComoALib(infDPSObject);

  // XSD exige o mesmo Id que a lib monta: municipio (7) + tipo (1) +
  // inscricao (14) + serie (5) + nDPS (15).
  const idSuffix = [
    cfg.codMunicipio,
    '2',
    cfg.cnpj,
    '00001',
    input.nDPS.padStart(15, '0'),
  ].join('');
  infDPSObject['$'] = { Id: `DPS${idSuffix}` };

  const builder = new xml2js.Builder({
    rootName: 'DPS',
    headless: true,
    renderOpts: { pretty: false },
  });

  let xml: string = builder.buildObject({
    $: { versao: '1.01', xmlns: 'http://www.sped.fazenda.gov.br/nfse' },
    infDPS: infDPSObject,
  });

  if (!xml.trim().startsWith('<?xml')) {
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
  } else {
    xml = xml.replace(/^<\?xml[^>]*\?>/, '<?xml version="1.0" encoding="UTF-8"?>');
  }
  return xml;
}

/** Valida o XML contra o XSD da DPS. Nao lanca: devolve o veredito. */
export async function validarXsd(xml: string): Promise<{ ok: boolean; msg: string }> {
  try {
    await NFE_SchemaValidate(xml, METODO_SCHEMA);
    return { ok: true, msg: 'XML valido contra o XSD' };
  } catch (err: unknown) {
    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);

    // libxmljs trata '^' e '$' como literais no pattern do XSD (as ancoras sao
    // implicitas e nao deveriam aparecer). O campo <serie> usa
    // pattern="^0{0,4}\d{1,5}$" — falso-positivo. A SEFIN aceitou serie='00001'
    // numa DPS real em 2026-07-04.
    if (msg.includes('<serie>') && msg.includes("pattern '^0{0,4}")) {
      const serie = /<serie>([^<]*)<\/serie>/.exec(xml)?.[1];
      if (serie === undefined || !SERIE_RE.test(serie)) {
        return { ok: false, msg: `XSD invalido: Série inválida: ${serie ?? '(ausente)'}` };
      }
      // O valor ^1$ cabe no limite da Série e contorna apenas o bug das âncoras
      // literais do libxmljs, permitindo que o schema revele outros erros.
      const xmlComSerieCorrigida = xml.replace(
        /<serie>[^<]*<\/serie>/,
        '<serie>^1$</serie>',
      );
      try {
        await NFE_SchemaValidate(xmlComSerieCorrigida, METODO_SCHEMA);
      } catch (erroCorrigido: unknown) {
        const msgCorrigida =
          typeof erroCorrigido === 'object' && erroCorrigido !== null && 'message' in erroCorrigido
            ? String((erroCorrigido as { message: unknown }).message)
            : String(erroCorrigido);
        return { ok: false, msg: `XSD invalido: ${msgCorrigida}` };
      }
      return { ok: true, msg: 'XML valido (aviso ignorado: bug de pattern do libxmljs no <serie>)' };
    }

    return { ok: false, msg: `XSD invalido: ${msg}` };
  }
}

/** Gera e valida numa tacada. Erro de montagem vira veredito, nao excecao. */
export async function conferirDps(
  input: EmissaoInput,
  cfg: ConfigPrestador,
): Promise<{ ok: boolean; msg: string; xml?: string }> {
  let xml: string;
  try {
    xml = gerarXmlDps(input, cfg);
  } catch (err) {
    return { ok: false, msg: `Erro ao gerar XML: ${String(err)}` };
  }
  const { ok, msg } = await validarXsd(xml);
  return { ok, msg, xml };
}
