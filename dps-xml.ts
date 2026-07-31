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

  // XSD exige Id no padrao DPS[0-9]{42}. Fora do envio real geramos um Id
  // equivalente: CNPJ do prestador (14) + nDPS preenchido com zeros ate 42.
  const idSuffix = (cfg.cnpj + input.nDPS.padStart(28, '0')).slice(0, 42);
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
