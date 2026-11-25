import { existsSync } from 'node:fs';
import { enviarEmailNota } from './email.js';
import { erroEmail } from './email-validacao.js';
import { mascararDocumentos } from './mascara.js';
import { buscarNotaPorVenda, initDb, listVendas } from './store.js';
import { exigirIdentificadorSeguro } from './validar-emissao.js';

export interface ReenviarNotaDeps {
  enviarEmailNota?: typeof enviarEmailNota;
  log?: (mensagem: string) => void;
}

export async function reenviarNota(
  idVenda: string,
  enviar: boolean,
  deps: ReenviarNotaDeps = {},
): Promise<void> {
  exigirIdentificadorSeguro(idVenda, 'id da Venda');
  const venda = listVendas({ id_venda: idVenda })[0];
  if (!venda) throw new Error(`Venda ${idVenda} não encontrada.`);

  const nota = buscarNotaPorVenda(idVenda);
  if (!nota) throw new Error(`Venda ${idVenda} não possui Nota emitida.`);

  const erro = erroEmail(venda.email);
  if (erro) throw new Error(`Venda ${idVenda}: ${erro}.`);

  const log = deps.log ?? ((mensagem: string) => console.log(mensagem));
  if (!enviar) {
    const arquivos = [
      ['XML da Nota', nota.xml_path],
      ['DANFSe PDF', nota.pdf_path],
    ] as const;
    log('Simulação: nenhum e-mail foi enviado.');
    log(`Venda: ${idVenda}`);
    log(`Destinatário: ${mascararDocumentos(venda.email!)}`);
    log(`Chave: ${nota.chave_acesso}`);
    for (const [nome, caminho] of arquivos) {
      const caminhoSeguro = caminho ? mascararDocumentos(caminho) : '(caminho não registrado)';
      log(`${nome}: ${caminhoSeguro} — ${caminho && existsSync(caminho) ? 'encontrado' : 'ausente'}`);
    }
    return;
  }

  await (deps.enviarEmailNota ?? enviarEmailNota)(venda, nota.chave_acesso);
  log(`E-mail reenviado para ${mascararDocumentos(venda.email!)}.`);
}

function parseArgs(args: string[]): { idVenda: string; enviar: boolean } {
  const idVenda = args[0];
  if (!idVenda || args.length > 2 || (args[1] && args[1] !== '--enviar')) {
    throw new Error('Uso: nfse reenviar <id_venda> [--enviar]');
  }
  exigirIdentificadorSeguro(idVenda, 'id da Venda');
  return { idVenda, enviar: args[1] === '--enviar' };
}

async function main(): Promise<void> {
  try {
    const { idVenda, enviar } = parseArgs(process.argv.slice(2));
    initDb();
    await reenviarNota(idVenda, enviar);
  } catch (err: unknown) {
    console.error(mascararDocumentos(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('reenviar.ts')) void main();
