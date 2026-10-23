export class ErroAntesDoEnvio extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ErroAntesDoEnvio";
  }
}

export function ehErroAntesDoEnvio(erro: unknown): erro is ErroAntesDoEnvio {
  return erro instanceof ErroAntesDoEnvio;
}
