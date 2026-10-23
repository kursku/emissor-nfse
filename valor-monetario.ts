const MAX_CENTAVOS = BigInt(Number.MAX_SAFE_INTEGER);

function invalido(valor: unknown): never {
  throw new Error(`valor monetário inválido: ${String(valor)}`);
}

function valorDeCentavos(
  inteiroTexto: string,
  casas: string,
  original: unknown,
): number {
  let centavos = BigInt(inteiroTexto.replaceAll(".", "")) * 100n;
  centavos += BigInt((casas + "00").slice(0, 2));
  if (casas.length > 2 && Number(casas[2]) >= 5) centavos++;

  if (centavos > MAX_CENTAVOS) invalido(original);
  return Number(centavos) / 100;
}

function arredondarNumero(valor: number): number {
  if (!Number.isFinite(valor) || valor < 0) invalido(valor);

  // Remove o ruído binário antes de usar o mesmo arredondamento decimal do texto.
  const partes = /^(\d+)(?:\.(\d+))?$/.exec(valor.toPrecision(15));
  if (!partes) invalido(valor);
  return valorDeCentavos(partes[1], partes[2] ?? "", valor);
}

/** Aceita número ou texto pt-BR e devolve valor arredondado a centavos. */
export function parseValorMonetario(valor: unknown): number {
  if (typeof valor === "number") return arredondarNumero(valor);
  if (typeof valor !== "string") invalido(valor);

  const texto = valor.trim();
  const partes = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?$/.exec(texto);
  if (!partes) invalido(valor);

  return valorDeCentavos(partes[1], partes[2] ?? "", valor);
}
