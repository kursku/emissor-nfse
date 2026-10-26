import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DanfseHtmlBuilder, DanfseXmlParser } from '@notaas/danfse-viewer';

import { adnDanfseUrl } from './ambiente.mjs';

const execFileAsync = promisify(execFile);
const PDF_HEADER = Buffer.from('%PDF');
const ADN_TIMEOUT_MS = 15_000;

export class DanfseBrowserUnavailableError extends Error {
  readonly code = 'DANFSE_BROWSER_UNAVAILABLE';

  constructor(
    message: string,
    readonly kind: 'configured' | 'none' = 'none',
  ) {
    super(message);
    this.name = 'DanfseBrowserUnavailableError';
  }
}

export interface GerarDanfsePdfOptions {
  browser?: string;
}

export type ResultadoDanfse =
  | { pdf: Buffer; origem: 'adn' | 'local' }
  | { html: string };

export interface ObterDanfseDeps {
  outputDir?: string;
  ambiente?: 1 | 2;
  browser?: string;
  baixarAdn?: (chave: string, ambiente: 1 | 2) => Promise<Buffer>;
  lerXml?: (path: string) => Promise<string>;
  gerarPdf?: (xml: string, opts?: GerarDanfsePdfOptions) => Promise<Buffer>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

function exigirPdf(buf: Buffer): Buffer {
  const fim = buf.subarray(Math.max(0, buf.length - 1024));
  if (!buf.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) || !fim.includes('%%EOF')) {
    throw new Error('resposta não é PDF');
  }
  return buf;
}

async function parseDanfse(xml: string) {
  const data = await new DanfseXmlParser().parse(xml);
  if (!/^\d{50}$/.test(data.chaveAcesso) || !data.nNFSe || data.nNFSe === '-') {
    throw new Error('XML DANFSe inválido: chave de acesso ou nNFSe ausente');
  }
  return data;
}

export async function extrairChaveDanfse(xml: string): Promise<string> {
  return (await parseDanfse(xml)).chaveAcesso;
}

export async function gerarDanfseHtml(xml: string): Promise<string> {
  return new DanfseHtmlBuilder().build(await parseDanfse(xml));
}

function arquivoExecutavel(caminho: string): boolean {
  try {
    const extensao = extname(caminho).toLowerCase();
    if (extensao === '.cmd' || extensao === '.bat') return false;
    if (!statSync(caminho).isFile()) return false;
    if (process.platform !== 'win32') accessSync(caminho, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function caminhoNoPath(nome: string): string | undefined {
  const extensaoNome = extname(nome).toLowerCase();
  if (extensaoNome === '.cmd' || extensaoNome === '.bat') return undefined;
  const extensoes = process.platform === 'win32'
    ? [...new Set((process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extensao) => extensao.trim().toLowerCase())
        .filter((extensao) => extensao && extensao !== '.cmd' && extensao !== '.bat')), '']
    : [''];
  for (const pasta of (process.env.PATH ?? '').split(delimiter)) {
    if (!pasta) continue;
    for (const extensao of extensoes) {
      const candidato = join(pasta, `${nome}${extensao}`);
      if (arquivoExecutavel(candidato)) return candidato;
    }
  }
  return undefined;
}

export function encontrarBrowser(configurado?: string): string {
  const valor = configurado?.trim();
  if (valor) {
    const encontrado = valor.includes('\\') || valor.includes('/')
      ? (arquivoExecutavel(valor) ? valor : undefined)
      : caminhoNoPath(valor);
    if (encontrado) return encontrado;
    throw new DanfseBrowserUnavailableError('browser DANFSe configurado não encontrado', 'configured');
  }

  const candidatos = process.platform === 'win32'
    ? [
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
          join(homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
          join(homedir(), 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        ]
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
          .map((nome) => caminhoNoPath(nome))
          .filter((candidato): candidato is string => Boolean(candidato));

  const browser = candidatos.find((candidato) => arquivoExecutavel(candidato));
  if (browser) return browser;
  throw new DanfseBrowserUnavailableError('nenhum browser DANFSe disponível', 'none');
}

async function gerarPdfDoHtml(html: string, browser?: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'nfse-danfse-'));
  const htmlPath = join(dir, 'danfse.html');
  const pdfPath = join(dir, 'danfse.pdf');
  const profilePath = join(dir, 'profile');

  try {
    await writeFile(htmlPath, html, 'utf8');
    const executavel = encontrarBrowser(browser);
    await execFileAsync(executavel, [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--user-data-dir=${profilePath}`,
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ], { timeout: 60_000, windowsHide: true });
    return exigirPdf(await readFile(pdfPath));
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      console.warn('DANFSe: falha ao limpar temporários');
    }
  }
}

export async function gerarDanfsePdf(
  xml: string,
  opts: GerarDanfsePdfOptions = {},
): Promise<Buffer> {
  return gerarPdfDoHtml(await gerarDanfseHtml(xml), opts.browser ?? process.env.NFSE_DANFSE_BROWSER);
}

export async function baixarDanfseAdn(chave: string, ambiente: 1 | 2): Promise<Buffer> {
  const { getComCertificado } = await import('./http-mtls.js');
  const resposta = await getComCertificado(adnDanfseUrl(ambiente, chave), {
    timeoutMs: ADN_TIMEOUT_MS,
    totalTimeoutMs: ADN_TIMEOUT_MS,
  });
  if (resposta.status !== 200) throw new Error(`ADN HTTP ${resposta.status}`);
  return exigirPdf(resposta.buf);
}

async function defaults(): Promise<{ outputDir: string; ambiente: 1 | 2; browser?: string }> {
  const { config } = await import('./config.js');
  return {
    outputDir: config.outputDir,
    ambiente: config.ambiente,
    browser: config.danfseBrowser || undefined,
  };
}

function logar(logger: Pick<Console, 'log' | 'warn'>, nivel: 'log' | 'warn', mensagem: string): void {
  logger[nivel](mensagem);
}

export async function obterDanfse(
  chave: string,
  deps: ObterDanfseDeps = {},
): Promise<ResultadoDanfse | null> {
  if (!/^\d{50}$/.test(chave)) throw new Error('chave de acesso inválida');
  const precisaConfig = deps.outputDir === undefined || deps.ambiente === undefined
    || (deps.browser === undefined && deps.gerarPdf === undefined);
  const configuracao = precisaConfig ? await defaults() : undefined;
  const outputDir = deps.outputDir ?? configuracao!.outputDir;
  const ambiente = deps.ambiente ?? configuracao!.ambiente;
  const browser = deps.browser ?? configuracao?.browser;
  const logger = deps.logger ?? console;
  const baixarAdn = deps.baixarAdn ?? baixarDanfseAdn;
  const lerXml = deps.lerXml ?? ((path: string) => readFile(path, 'utf8'));
  const gerarPdf = deps.gerarPdf ?? gerarDanfsePdf;
  let motivoAdn = 'falha na consulta ADN';

  try {
    const pdf = exigirPdf(await baixarAdn(chave, ambiente));
    logar(logger, 'log', '  DANFSe: ADN');
    return { pdf, origem: 'adn' };
  } catch (err) {
    if (err instanceof Error && /^ADN HTTP \d+$/.test(err.message)) motivoAdn = err.message;
    else if (err instanceof Error && err.message === 'resposta não é PDF') motivoAdn = 'ADN sem PDF';
  }

  const xmlSrc = join(outputDir, 'autorizacao', `${chave}.xml`);
  let xml: string;
  try {
    xml = await lerXml(xmlSrc);
  } catch (err) {
    const motivo = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? `XML ausente em ${xmlSrc}`
      : 'XML inválido';
    logar(logger, 'warn', `  DANFSe indisponivel (${motivoAdn}; ${motivo}), enviando sem anexo`);
    return null;
  }

  let data: Awaited<ReturnType<typeof parseDanfse>>;
  try {
    data = await parseDanfse(xml);
  } catch {
    logar(logger, 'warn', `  DANFSe indisponivel (${motivoAdn}; XML inválido), enviando sem anexo`);
    return null;
  }
  if (data.chaveAcesso !== chave) {
    logar(logger, 'warn', `  DANFSe indisponivel (${motivoAdn}; chave do XML divergente), enviando sem anexo`);
    return null;
  }

  try {
    const pdf = exigirPdf(await gerarPdf(xml, { browser }));
    logar(logger, 'log', '  DANFSe: gerado localmente a partir do XML original; eventos posteriores não são refletidos');
    return { pdf, origem: 'local' };
  } catch (err) {
    const motivo = err instanceof DanfseBrowserUnavailableError
      ? err.kind === 'configured'
        ? 'browser configurado não encontrado (NFSE_DANFSE_BROWSER)'
        : 'nenhum browser instalado'
      : 'browser falhou';
    logar(logger, 'warn', `  DANFSe indisponivel (${motivoAdn}; ${motivo}), salvando HTML sem anexo`);
    return { html: await gerarDanfseHtml(xml) };
  }
}
