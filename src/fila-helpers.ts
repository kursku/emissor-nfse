/**
 * Helpers puros usados por fila.ts: montagem de EmissaoInput a partir de uma
 * Venda e lookup em mapa_produtos. Extraídos para um módulo sem import de
 * config.ts — fila.ts carrega config no topo (obrigatório para a fila real),
 * o que derruba o processo em ambiente sem NFSE_* (ex.: CI). Testar esses
 * helpers exige importá-los sem puxar esse import junto.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Venda } from './store.js';
import type { EmissaoInput } from './montar-dps.js';
import { mascaraDoc } from './mascara.js';

export function deveInterromperFilaAposVerificacao(
  modoReal: boolean,
  resultado: string,
): boolean {
  return modoReal && resultado === 'a_verificar';
}

/** Remove não-dígitos e devolve string limpa */
function soDigitos(v: string | undefined | null): string {
  return (v ?? '').replace(/\D/g, '');
}

export const C_IND_OP_COM_ENDERECO = '100301';

export function cIndOpExigeEndereco(cIndOp: unknown): boolean {
  return cIndOp === C_IND_OP_COM_ENDERECO;
}

/** Mapeia produto do banco para os campos fiscais via mapa_produtos */
export interface MapaFiscal {
  ctrib_nac: string;
  cnbs: string;
  xdesc_serv: string;
}

export function buscarMapaProduto(
  db: DatabaseSync,
  produto: string,
): MapaFiscal | null {
  const row = db
    .prepare('SELECT ctrib_nac, cnbs, xdesc_serv FROM mapa_produtos WHERE produto = ?')
    .get(produto) as unknown as MapaFiscal | undefined;
  return row ?? null;
}

/** Contratos mantêm os próprios códigos; Vendas importadas usam mapa_produtos. */
export function buscarMapaFiscal(
  db: DatabaseSync,
  venda: Pick<Venda, "contrato_id" | "produto">,
): MapaFiscal | null {
  if (venda.contrato_id !== undefined && venda.contrato_id !== null) {
    const row = db
      .prepare("SELECT ctrib_nac, cnbs, xdesc_serv FROM contratos WHERE id = ? AND cnbs IS NOT NULL AND cnbs <> ''")
      .get(venda.contrato_id) as unknown as MapaFiscal | undefined;
    return row ?? null;
  }
  return buscarMapaProduto(db, venda.produto ?? "");
}

/**
 * Monta EmissaoInput a partir de uma venda do banco.
 * - tomador: CPF (11 dígitos) ou CNPJ (14 dígitos)
 * - endereço: incluído só se completo (cMun IBGE + CEP + rua + numero + bairro)
 *   A Lastlink retorna cidade/UF como texto, não código IBGE — se não houver
 *   código IBGE, o endereço é omitido inteiramente (XSD permite, minOccurs=0).
 * - nDPS em simulação: sequencial local (não persiste em `notas`)
 */
export function montarInput(
  venda: Venda,
  mapa: MapaFiscal,
  nDPS: string,
): EmissaoInput {
  const docRaw = soDigitos(venda.cpf_cnpj);
  const isCpf = docRaw.length === 11;
  const isCnpj = docRaw.length === 14;

  if (!isCpf && !isCnpj) {
    throw new Error(
      `Documento inválido para id_venda=${venda.id_venda}: "${mascaraDoc(venda.cpf_cnpj)}" (tamanho=${docRaw.length})`,
    );
  }

  // Endereco do tomador: obrigatorio para este indicador de operacao — sem ele
  // a SEFIN recusa a nota com E0234. So entra completo; faltando qualquer
  // parte, a venda nao deveria ter chegado aqui (a importacao a classifica
  // como 'pronta_sem_endereco').
  const temEnderecoCompleto = Boolean(
    venda.cmun && venda.cep && venda.rua && venda.numero && venda.bairro,
  );

  return {
    nDPS,
    tomador: {
      ...(isCpf ? { CPF: docRaw } : { CNPJ: docRaw }),
      xNome: venda.nome!,
      ...(temEnderecoCompleto
        ? {
            end: {
              cMun: venda.cmun!, // resolvido pelo CEP na importacao
              CEP: soDigitos(venda.cep),
              xLgr: venda.rua!,
              nro: venda.numero!,
              xBairro: venda.bairro!,
              ...(venda.complemento ? { xCpl: venda.complemento } : {}),
            },
          }
        : {}),
      ...(venda.email ? { email: venda.email } : {}),
    },
    xDescServ: mapa.xdesc_serv,
    vServ: venda.valor!,
    cTribNac: mapa.ctrib_nac,
    cNBS: mapa.cnbs,
    cIndOp: C_IND_OP_COM_ENDERECO,
    cClassTrib: '000001',
  };
}
