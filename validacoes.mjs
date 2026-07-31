/**
 * validacoes.mjs — validacoes de borda dos campos fiscais.
 *
 * Cada funcao devolve `null` quando o valor e aceitavel, ou uma string com o
 * problema em linguagem de operador. Sem dependencias e sem efeito colateral,
 * para poder ser importado tanto pelo setup (.mjs, roda antes do npm install)
 * quanto pelos modulos TypeScript.
 *
 * Codigo fiscal errado produz nota errada, e nota emitida em producao nao se
 * desfaz — por isso o formato e checado aqui, na entrada, e nao na SEFIN.
 */

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

/** Digito verificador de CNPJ pelo algoritmo modulo 11. */
function dvCnpj(base) {
  let peso = base.length - 7;
  let soma = 0;
  for (const ch of base) {
    soma += Number(ch) * peso--;
    if (peso < 2) peso = 9;
  }
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

/** CNPJ com 14 digitos e digitos verificadores conferidos. */
export function cnpjInvalido(valor) {
  const d = digitos(valor);
  if (d.length !== 14) return 'CNPJ precisa ter 14 digitos.';
  if (/^(\d)\1{13}$/.test(d)) return 'CNPJ invalido (digitos repetidos).';
  if (dvCnpj(d.slice(0, 12)) !== Number(d[12]) || dvCnpj(d.slice(0, 13)) !== Number(d[13])) {
    return 'CNPJ invalido (digito verificador nao confere).';
  }
  return null;
}

/** CPF com 11 digitos e digitos verificadores conferidos. */
export function cpfInvalido(valor) {
  const d = digitos(valor);
  if (d.length !== 11) return 'CPF precisa ter 11 digitos.';
  if (/^(\d)\1{10}$/.test(d)) return 'CPF invalido (digitos repetidos).';
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(d[i]) * (10 - i);
  if ((((soma * 10) % 11) % 10) !== Number(d[9])) {
    return 'CPF invalido (digito verificador nao confere).';
  }
  soma = 0;
  for (let i = 0; i < 10; i++) soma += Number(d[i]) * (11 - i);
  if ((((soma * 10) % 11) % 10) !== Number(d[10])) {
    return 'CPF invalido (digito verificador nao confere).';
  }
  return null;
}

/**
 * Documento do tomador: o XSD aceita CPF (11) ou CNPJ (14), nunca os dois.
 * Recebe o objeto do tomador para poder reclamar da ausencia dos dois campos.
 */
export function docTomadorInvalido(tomador) {
  const cpf = digitos(tomador?.CPF);
  const cnpj = digitos(tomador?.CNPJ);
  if (cpf && cnpj) return 'tomador tem CPF e CNPJ ao mesmo tempo — informe apenas um.';
  if (cpf) return cpfInvalido(cpf);
  if (cnpj) return cnpjInvalido(cnpj);
  return 'tomador precisa de CPF ou CNPJ.';
}

/** Item da LC 116/2003: 6 digitos (ex.: 080201). */
export function cTribNacInvalido(valor) {
  return /^\d{6}$/.test(String(valor ?? ''))
    ? null
    : 'cTribNac precisa ter 6 digitos — item da LC 116/2003, ex.: 080201.';
}

/** Nomenclatura Brasileira de Servicos: 9 digitos. */
export function cNBSInvalido(valor) {
  return /^\d{9}$/.test(String(valor ?? ''))
    ? null
    : 'cNBS precisa ter 9 digitos — Nomenclatura Brasileira de Servicos.';
}

/** Codigo IBGE de municipio: 7 digitos. */
export function codMunicipioInvalido(valor) {
  return /^\d{7}$/.test(String(valor ?? ''))
    ? null
    : 'codigo IBGE do municipio precisa ter 7 digitos.';
}

/** CEP: 8 digitos. */
export function cepInvalido(valor) {
  return /^\d{8}$/.test(digitos(valor)) ? null : 'CEP precisa ter 8 digitos.';
}

/** Valor do servico: numero finito e maior que zero. */
export function vServInvalido(valor) {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? null
    : 'vServ precisa ser um numero maior que zero.';
}
