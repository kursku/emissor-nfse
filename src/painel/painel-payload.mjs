export function montarPayloadFormulario(campos) {
  const texto = (nome) => String(campos[nome] ?? '').trim();
  const documento = texto('documento');

  return {
    vServ: parseFloat(texto('vServ')),
    tomador: {
      ...(documento.length === 11 ? { CPF: documento } : { CNPJ: documento }),
      xNome: texto('xNome'),
      end: {
        cMun: texto('cMun'),
        CEP: texto('CEP'),
        xLgr: texto('xLgr'),
        nro: texto('nro'),
        xCpl: texto('xCpl') || undefined,
        xBairro: texto('xBairro'),
      },
      fone: texto('fone') || undefined,
      email: texto('email') || undefined,
    },
    xDescServ: texto('xDescServ'),
    cTribNac: texto('cTribNac'),
    cNBS: texto('cNBS'),
    cIndOp: texto('cIndOp'),
    cClassTrib: texto('cClassTrib'),
  };
}
