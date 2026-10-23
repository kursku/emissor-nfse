const ADN_HOST = {
  1: 'https://adn.nfse.gov.br',
  2: 'https://adn.producaorestrita.nfse.gov.br',
};

export const DATA_IMPLANTACAO_NOVO_LEIAUTE = '2026-12-01';

export function exigirLeiauteNovoPermitido(ambiente, agora = new Date()) {
  const dCompet = agora.toLocaleString('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
  }).slice(0, 10);
  if (ambiente === 1 && dCompet < DATA_IMPLANTACAO_NOVO_LEIAUTE) {
    throw new Error(
      `NFSE_AMBIENTE=1 recusado até ${DATA_IMPLANTACAO_NOVO_LEIAUTE}: ` +
        'o leiaute NT 009 só entra em produção nessa data.',
    );
  }
}

export function recusaLeiauteNovo(real, ambiente, agora = new Date()) {
  if (!real) return null;
  try {
    exigirLeiauteNovoPermitido(ambiente, agora);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function ambienteFilho(env, real) {
  return { ...env, EMITIR_REAL: real ? '1' : '0' };
}

export function recusaModoReal(real, ambiente) {
  if (real && ambiente === 2) {
    return 'MODO REAL recusado: NFSE_AMBIENTE=2 é produção restrita e não gera nota fiscal real.';
  }
  return null;
}

export function adnDanfseUrl(ambiente, chave) {
  const host = ADN_HOST[ambiente];
  if (!host) throw new Error(`NFSE_AMBIENTE inválido: ${ambiente}`);
  return `${host}/danfse/${chave}`;
}
