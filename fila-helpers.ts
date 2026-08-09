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

/** Remove não-dígitos e devolve string limpa */
function soDigitos(v: string | undefined | null): string {
  return (v ?? '').replace(/\D/g, '');
}

/** Mapeia produto do banco para os campos fiscais via mapa_produtos */
export function buscarMapaProduto(
  db: DatabaseSync,
  produto: string,
): { ctrib_nac: string; cnbs: string; xdesc_serv: string } | null {
  const row = db
    .prepare('SELECT ctrib_nac, cnbs, xdesc_serv FROM mapa_produtos WHERE produto = ?')
    .get(produto) as { ctrib_nac: string; cnbs: string; xdesc_serv: string } | undefined;
  return row ?? null;
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
  mapa: { ctrib_nac: string; cnbs: string; xdesc_serv: string },
  nDPS: string,
): EmissaoInput {
  const docRaw = soDigitos(venda.cpf_cnpj);
  const isCpf = docRaw.length === 11;
  const isCnpj = docRaw.length === 14;

  if (!isCpf && !isCnpj) {
    throw new Error(
      `Documento inválido para id_venda=${venda.id_venda}: "${venda.cpf_cnpj}" (normalizado: "${docRaw}", tamanho=${docRaw.length})`,
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
            },
          }
        : {}),
      ...(venda.email ? { email: venda.email } : {}),
    },
    xDescServ: mapa.xdesc_serv,
    vServ: venda.valor!,
    cTribNac: mapa.ctrib_nac,
    cNBS: mapa.cnbs,
    cIndOp: '100301',
    cClassTrib: '000001',
  };
}
