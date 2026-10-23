import {
  cepInvalido,
  cNBSInvalido,
  cTribNacInvalido,
  codMunicipioInvalido,
  docTomadorInvalido,
  vServInvalido,
} from './validacoes.mjs';
import { chaveAcessoValida } from './chave-acesso.js';
import { cIndOpExigeEndereco } from './fila-helpers.js';

export interface IdentificadoresEmissao {
  idVenda?: unknown;
  chaveAcesso?: unknown;
}

const ID_VENDA_RE = /^[A-Za-z0-9_-]+$/;

function registro(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

function textoPreenchido(valor: unknown): boolean {
  return typeof valor === 'string' && valor.trim() !== '';
}

function somenteDigitos(valor: unknown): boolean {
  return typeof valor === 'string' && /^\d+$/.test(valor);
}

function campoObrigatorio(problemas: string[], nome: string, valor: unknown): void {
  if (!textoPreenchido(valor)) problemas.push(`${nome} é obrigatório.`);
}

/** Só caracteres de identificador, sem pontos, barras ou outros separadores. */
export function erroIdentificadorSeguro(valor: unknown, nome: string): string | null {
  return typeof valor === 'string' && ID_VENDA_RE.test(valor)
    ? null
    : `${nome} contém caracteres inválidos.`;
}

export function exigirIdentificadorSeguro(valor: unknown, nome: string): void {
  const erro = erroIdentificadorSeguro(valor, nome);
  if (erro) throw new Error(erro);
}

export function validarEmissao(
  input: unknown,
  identificadores: IdentificadoresEmissao = {},
): string[] {
  const problemas: string[] = [];
  const emissao = registro(input);
  if (!emissao) return ['corpo da emissão é obrigatório.'];

  if (typeof emissao.nDPS !== 'string' || !/^[1-9]\d*$/.test(emissao.nDPS)) {
    problemas.push('nDPS deve ser um inteiro positivo.');
  }

  const tomador = registro(emissao.tomador);
  if (!tomador) {
    problemas.push('tomador é obrigatório.');
  } else {
    campoObrigatorio(problemas, 'tomador.xNome', tomador.xNome);
    if (tomador.CPF !== undefined && !somenteDigitos(tomador.CPF)) {
      problemas.push('CPF do Tomador deve conter apenas dígitos.');
    }
    if (tomador.CNPJ !== undefined && !somenteDigitos(tomador.CNPJ)) {
      problemas.push('CNPJ do Tomador deve conter apenas dígitos.');
    }
    const erroDocumento = docTomadorInvalido(tomador);
    if (erroDocumento) problemas.push(`Documento do Tomador inválido: ${erroDocumento}`);

    if (tomador.end !== undefined) {
      const endereco = registro(tomador.end);
      if (!endereco) {
        problemas.push('tomador.end deve ser um objeto.');
      } else {
        for (const campo of ['cMun', 'CEP', 'xLgr', 'nro', 'xBairro']) {
          campoObrigatorio(problemas, `tomador.end.${campo}`, endereco[campo]);
        }
        if (endereco.CEP !== undefined && !somenteDigitos(endereco.CEP)) {
          problemas.push('tomador.end.CEP deve conter apenas dígitos.');
        }
        const erroMunicipio = codMunicipioInvalido(endereco.cMun);
        if (erroMunicipio) problemas.push(erroMunicipio);
        const erroCep = cepInvalido(endereco.CEP);
        if (erroCep) problemas.push(erroCep);
      }
    }
  }

  if (cIndOpExigeEndereco(emissao.cIndOp) && (!tomador || !tomador.end)) {
    problemas.push('tomador.end é obrigatório para este cIndOp.');
  }

  campoObrigatorio(problemas, 'xDescServ', emissao.xDescServ);
  campoObrigatorio(problemas, 'cIndOp', emissao.cIndOp);
  campoObrigatorio(problemas, 'cClassTrib', emissao.cClassTrib);

  const erroValor = vServInvalido(emissao.vServ);
  if (erroValor) problemas.push(erroValor);
  const erroCTrib = cTribNacInvalido(emissao.cTribNac);
  if (erroCTrib) problemas.push(erroCTrib);
  const erroCNbs = cNBSInvalido(emissao.cNBS);
  if (erroCNbs) problemas.push(erroCNbs);

  const pTotTribSN = emissao.pTotTribSN;
  if (
    pTotTribSN !== undefined &&
    (typeof pTotTribSN !== 'number' ||
      !Number.isFinite(pTotTribSN) ||
      pTotTribSN < 0 ||
      pTotTribSN > 100)
  ) {
    problemas.push('pTotTribSN deve ser um número finito entre 0 e 100.');
  }

  if ('idVenda' in identificadores) {
    const erroId = erroIdentificadorSeguro(identificadores.idVenda, 'id da Venda');
    if (erroId) problemas.push(erroId);
  }
  if ('chaveAcesso' in identificadores &&
      !chaveAcessoValida(identificadores.chaveAcesso)) {
    problemas.push('Chave de acesso deve ter 50 dígitos numéricos.');
  }

  return problemas;
}

export function exigirEmissaoValida(
  input: unknown,
  identificadores: IdentificadoresEmissao = {},
): void {
  const problemas = validarEmissao(input, identificadores);
  if (problemas.length > 0) {
    throw new Error(`Emissão inválida:\n  - ${problemas.join('\n  - ')}`);
  }
}
