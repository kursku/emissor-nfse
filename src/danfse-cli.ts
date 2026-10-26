import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import {
  DanfseBrowserUnavailableError,
  gerarDanfseHtml,
  gerarDanfsePdf,
} from './danfse.js';

async function browserConfigurado(): Promise<string | undefined> {
  const sair = process.exit;
  const erro = console.error;
  process.exit = ((code?: number) => {
    throw new Error(`configuração indisponível (${code ?? 0})`);
  }) as typeof process.exit;
  console.error = () => {};
  try {
    const { config } = await import('./config.js');
    return config.danfseBrowser || process.env.NFSE_DANFSE_BROWSER?.trim() || undefined;
  } catch {
    return process.env.NFSE_DANFSE_BROWSER?.trim() || undefined;
  } finally {
    process.exit = sair;
    console.error = erro;
  }
}

const [xmlPath, outputArg] = process.argv.slice(2);
if (!xmlPath) {
  console.error('Uso: nfse danfse <nota.xml> [saida.pdf]');
  process.exitCode = 1;
} else {
  try {
    const xml = await readFile(xmlPath, 'utf8');
    const output = outputArg ?? join(dirname(xmlPath), `${basename(xmlPath, extname(xmlPath))}.pdf`);
    try {
      const pdf = await gerarDanfsePdf(xml, { browser: await browserConfigurado() });
      await writeFile(output, pdf);
      console.log(`PDF  -> ${output} (${pdf.length} bytes)`);
    } catch (err) {
      const htmlPath = output.toLowerCase().endsWith('.pdf')
        ? `${output.slice(0, -4)}.html`
        : `${output}.html`;
      await writeFile(htmlPath, await gerarDanfseHtml(xml), 'utf8');
      const motivo = err instanceof DanfseBrowserUnavailableError
        ? err.kind === 'configured'
          ? 'browser configurado não encontrado (NFSE_DANFSE_BROWSER)'
          : 'nenhum browser instalado'
        : 'browser falhou';
      console.warn(`AVISO: ${motivo}; HTML salvo em ${htmlPath}`);
      console.log(`HTML -> ${htmlPath}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
