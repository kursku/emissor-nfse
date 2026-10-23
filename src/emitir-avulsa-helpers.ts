export function comandoConciliacao(idVenda: string, chaveAcesso?: string, rejeitada = false): string {
  return rejeitada
    ? `nfse conciliar ${idVenda} --rejeitada`
    : `nfse conciliar ${idVenda} --chave ${chaveAcesso ?? '<chave_acesso>'}`;
}
