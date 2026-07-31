/**
 * endereco-lastlink.ts — interpreta o campo "Endereco do membro" do export.
 *
 * A planilha traz o endereco como uma unica string, separada por virgulas:
 *
 *   "Rua Exemplo 123, Centro, 01001000, Cidade Exemplo - SP"
 *    └─ logradouro + nro ─┘  └bairro┘  └─CEP─┘  └─cidade─┘ UF
 *
 * Funcao pura, sem rede: o codigo IBGE do municipio NAO esta aqui e e
 * resolvido depois, pelo CEP. Devolve `null` quando o texto nao tem as quatro
 * partes ou o CEP nao tem 8 digitos — endereco incompleto e pior que ausente,
 * porque a SEFIN recusa a nota inteira.
 */

export interface EnderecoLastlink {
  xLgr: string;
  nro: string;
  xBairro: string;
  CEP: string;
  cidade: string;
  uf: string;
}

const soDigitos = (v: string) => v.replace(/\D/g, '');

export function parseEnderecoLastlink(texto: string | undefined | null): EnderecoLastlink | null {
  const partes = String(texto ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (partes.length < 4) return null;

  // As tres ultimas posicoes sao fixas (bairro, CEP, cidade - UF); o que sobra
  // na frente e logradouro + numero. Assim um logradouro com virgula extra
  // ("Rua X, 10, apto 2, Centro, CEP, Cidade - SP") nao desloca o resto.
  const cidadeUf = partes[partes.length - 1];
  const cep = soDigitos(partes[partes.length - 2]);
  const bairro = partes[partes.length - 3];
  const logradouroNro = partes.slice(0, partes.length - 3).join(', ');

  if (cep.length !== 8) return null;
  if (!bairro || !logradouroNro) return null;

  const mCidade = /^(.*?)\s*-\s*([A-Za-z]{2})$/.exec(cidadeUf);
  if (!mCidade) return null;

  // numero = ultimo grupo de digitos do trecho de logradouro
  const mNro = /^(.*?)[\s,]*(\d+[A-Za-z]?)\s*$/.exec(logradouroNro);
  const xLgr = (mNro ? mNro[1] : logradouroNro).trim().replace(/,$/, '');
  const nro = mNro ? mNro[2] : 'S/N';

  if (!xLgr) return null;

  return {
    xLgr,
    nro,
    xBairro: bairro,
    CEP: cep,
    cidade: mCidade[1].trim(),
    uf: mCidade[2].toUpperCase(),
  };
}
