import { chaveAcessoValida } from './chave-acesso.js';
import { conciliarComChave, conciliarRejeitada, initDb } from './store.js';

export type ConciliacaoArgs =
  | { idVenda: string; chave: string }
  | { idVenda: string; rejeitada: true };

export function parseConciliacaoArgs(args: string[]): ConciliacaoArgs {
  const idVenda = args[0];
  if (!idVenda) throw new Error('Uso: nfse conciliar <id_venda> --chave <chave_acesso> | --rejeitada');

  const chaveIndex = args.indexOf('--chave');
  const rejeitada = args.includes('--rejeitada');
  if ((chaveIndex >= 0) === rejeitada) {
    throw new Error('Informe exatamente uma das opções --chave ou --rejeitada.');
  }
  if (chaveIndex >= 0) {
    if (chaveIndex !== 1 || args.length !== 3) {
      throw new Error('A opção --chave exige exatamente <id_venda> --chave <chave_acesso>.');
    }
    const chave = args[chaveIndex + 1];
    if (!chave || !chaveAcessoValida(chave)) {
      throw new Error('A opção --chave exige uma Chave de acesso válida de 50 dígitos.');
    }
    return { idVenda, chave };
  }
  if (args.length !== 2) throw new Error('A opção --rejeitada não aceita outros argumentos.');
  return { idVenda, rejeitada: true };
}

function main(): void {
  try {
    const args = parseConciliacaoArgs(process.argv.slice(2));
    initDb();
    if ('chave' in args) {
      conciliarComChave(args.idVenda, args.chave);
      console.log(`Venda ${args.idVenda} conciliada como emitida.`);
    } else {
      conciliarRejeitada(args.idVenda);
      console.log(`Venda ${args.idVenda} conciliada como rejeitada; retry explícito disponível.`);
    }
  } catch (erro: unknown) {
    console.error(erro instanceof Error ? erro.message : String(erro));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('conciliar.ts')) main();
