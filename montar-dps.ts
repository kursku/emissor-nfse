/**
 * montar-dps.ts — montagem da DPS. Funcao pura, sem I/O e sem rede.
 *
 * Separado de `emissor.ts` de proposito: aquele modulo, ao ser carregado,
 * exige `.env` completo, cria diretorios e troca o agente HTTPS global. Aqui
 * nao ha efeito colateral nenhum, entao a montagem pode ser testada sem
 * certificado, sem configuracao e sem rede — este e o seam do projeto.
 */
import type { LayoutDPS } from '@nfewizard/types';

export interface TomadorEndereco {
  cMun: string;
  CEP: string;
  xLgr: string;
  nro: string;
  xCpl?: string;
  xBairro: string;
}

export interface EmissaoInput {
  nDPS: string;
  tomador: {
    /** CPF (11 dígitos) ou CNPJ (14 dígitos) — normalizado sem pontuação */
    CNPJ?: string;
    CPF?: string;
    xNome: string;
    /** Endereço completo — omitir se faltar cMun IBGE, CEP, rua, numero ou bairro */
    end?: TomadorEndereco;
    fone?: string;
    email?: string;
  };
  xDescServ: string;
  vServ: number;
  /** Item da LC 116/2003, 6 dígitos (ex.: 080201 = instrução e treinamento) */
  cTribNac: string;
  /** Nomenclatura Brasileira de Serviços, 9 dígitos */
  cNBS: string;
  cIndOp: string;
  cClassTrib: string;
  /**
   * % aproximado de tributos do Simples (Lei da Transparencia) — alíquota
   * inicial do anexo do serviço. Anexo III = 6,00; Anexo V = 15,50.
   * Default: `pTotTribSN` da configuração.
   */
  pTotTribSN?: number;
}

/** O subconjunto da configuração que a montagem consome. */
export interface ConfigPrestador {
  cnpj: string;
  im: string;
  codMunicipio: string;
  ambiente: 1 | 2;
  regTrib: {
    opSimpNac: 1 | 2 | 3;
    regApTribSN: 1 | 2 | 3;
    regEspTrib: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 9;
  };
  pTotTribSN: number;
}

/** Data e competência no fuso de São Paulo, formato exigido pelo layout. */
export function momentoSP(agora: Date): { dhEmi: string; dCompet: string } {
  const local = agora.toLocaleString('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
  });
  return { dhEmi: local.replace(' ', 'T') + '-03:00', dCompet: local.slice(0, 10) };
}

export function montarDps(
  input: EmissaoInput,
  cfg: ConfigPrestador,
  agora: Date = new Date(),
): LayoutDPS {
  const { dhEmi, dCompet } = momentoSP(agora);
  const meEpp = cfg.regTrib.opSimpNac === 3;
  return {
    infDps: {
      tpAmb: cfg.ambiente,
      dhEmi,
      verAplic: '1.0',
      serie: '00001',
      nDPS: input.nDPS,
      dCompet,
      tpEmit: 1,
      cLocEmi: cfg.codMunicipio,
      prest: {
        CNPJ: cfg.cnpj,
        IM: cfg.im, // exigida pelo cadastro (CNC) do municipio (E0116)
        // E0121/E0128: nome, endereco e contatos do prestador NAO podem vir na DPS
        // quando ele e o proprio emitente (tpEmit=1) - a SEFIN usa o cadastro (CNC)
        // opSimpNac 3 = optante ME/EPP exige regApTribSN (E0166)
        regTrib: {
          opSimpNac: cfg.regTrib.opSimpNac,
          ...(meEpp ? { regApTribSN: cfg.regTrib.regApTribSN } : {}),
          regEspTrib: cfg.regTrib.regEspTrib,
        },
      },
      toma: {
        // XSD TCInfoPessoa: choice CNPJ | CPF — decidido por tamanho do doc normalizado
        ...(input.tomador.CPF ? { CPF: input.tomador.CPF } : { CNPJ: input.tomador.CNPJ }),
        xNome: input.tomador.xNome,
        // end é opcional no XSD (minOccurs=0) — incluir só se completo
        ...(input.tomador.end
          ? {
              end: {
                endNac: {
                  cMun: input.tomador.end.cMun,
                  CEP: input.tomador.end.CEP,
                },
                xLgr: input.tomador.end.xLgr,
                nro: input.tomador.end.nro,
                ...(input.tomador.end.xCpl ? { xCpl: input.tomador.end.xCpl } : {}),
                xBairro: input.tomador.end.xBairro,
              },
            }
          : {}),
        ...(input.tomador.fone ? { fone: input.tomador.fone } : {}),
        ...(input.tomador.email ? { email: input.tomador.email } : {}),
      },
      serv: {
        locPrest: { cLocPrestacao: cfg.codMunicipio },
        cServ: {
          cTribNac: input.cTribNac,
          cNBS: input.cNBS,
          xDescServ: input.xDescServ,
        },
      },
      valores: {
        vServPrest: { vServ: input.vServ },
        trib: {
          tribMun: { tribISSQN: 1, tpRetISSQN: 1 },
          tribFed: { piscofins: { CST: '08' } },
          // totTrib e obrigatorio no XSD; E0712 proibe indTotTrib para ME/EPP,
          // que deve usar pTotTribSN (% aproximado da aliquota inicial do anexo do Simples)
          totTrib: { pTotTribSN: input.pTotTribSN ?? cfg.pTotTribSN },
        },
      },
      IBSCBS: {
        finNFSe: '0',
        cIndOp: input.cIndOp,
        indDest: '0',
        valores: {
          trib: { gIBSCBS: { CST: '000', cClassTrib: input.cClassTrib } },
        },
      },
    },
  };
}
