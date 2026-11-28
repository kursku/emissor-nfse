/**
 * Modelo de leitura das Notas: registro do banco + Venda + XML autorizado local.
 * Só lê: abre o banco como somente leitura e não grava arquivo.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import xml2js from 'xml2js';

import { chaveAcessoValida } from './chave-acesso.js';
import { parseDanfse } from './danfse.js';
import { mascaraDoc, mascararDocumentos } from './mascara.js';
import { momentoSP } from './montar-dps.js';
import { parseValorMonetario } from './valor-monetario.js';

export interface NotaListada {
  nNFSe: string | null;
  ndps: number;
  chave: string;
  emitidaEm: string | null;
  competencia: string;
  competenciaEstimada: boolean;
  tomador: string | null;
  documentoMascarado: string;
  valor: number | null;
  /** XML com tpAmb=2: aparece na lista, fora do total e da quantidade. */
  homologacao: boolean;
  idVenda: string | null;
  temXml: boolean;
  temPdf: boolean;
}

export interface CompetenciaResumo {
  competencia: string;
  total: number;
  quantidade: number;
  estimada: boolean;
}

interface Registro {
  chave_acesso: string;
  ndps: number;
  id_venda: string | null;
  emitida_em: string | null;
  valor: number | null;
  nome: string | null;
  cpf_cnpj: string | null;
  data_venda: string | null;
}

type CamposDoXml = Pick<NotaListada, 'nNFSe' | 'competencia' | 'tomador' | 'documentoMascarado' | 'valor' | 'homologacao'>;

function avisar(oQue: string, chave: string, err: unknown): void {
  const motivo = err instanceof Error ? err.message : String(err);
  console.warn(mascararDocumentos(`[notas] ${oQue}, chave ${chave}: `) + mascararDocumentos(motivo));
}

// O parser do DANFSe corta o nome para a impressão e deixa referências numéricas cruas.
async function nomeDoTomador(xml: string): Promise<string | null> {
  const raiz = await xml2js.parseStringPromise(xml, { explicitArray: false });
  // Os mesmos envelopes que o parser do DANFSe aceita.
  const nfse = raiz.NFSe ?? raiz.retNFSe?.NFSe ?? raiz.NFSeProc?.NFSe ?? raiz;
  const nome: unknown = (nfse.infNFSe ?? nfse).DPS?.infDPS?.toma?.xNome;
  return typeof nome === 'string' ? nome.trim() || null : null;
}

/** O parser do DANFSe devolve texto formatado para impressão; aqui volta a ser dado. */
async function lerCamposDoXml(xml: string, chave: string): Promise<CamposDoXml> {
  const dados = await parseDanfse(xml);
  if (dados.chaveAcesso !== chave) throw new Error('chave do XML diverge da Nota');
  const data = /^\d{2}\/(\d{2})\/(\d{4})$/.exec(dados.dCompet);
  if (!data) throw new Error('dCompet ausente ou inválida');
  return {
    nNFSe: dados.nNFSe,
    competencia: `${data[2]}-${data[1]}`,
    // XML sem <toma> é válido.
    // O xml2js é mais estrito que o parser do DANFSe: se recusar, só o nome degrada.
    tomador: await nomeDoTomador(xml).catch((err: unknown) => {
      avisar('nome do tomador pode estar cortado', chave, err);
      const nome = dados.tomador?.xNome;
      return nome && nome !== '-' ? nome : null;
    }),
    documentoMascarado: mascaraDoc(dados.tomador?.doc),
    valor: parseValorMonetario(dados.vServ.replace(/^R\$\s*/, '')),
    homologacao: dados.tpAmb === 'Homologação',
  };
}

// Cada parse custa alguns ms e toda consulta passa por todos os XMLs: guarda enquanto o arquivo
// não muda, inclusive a recusa (null), para um XML ruim avisar uma vez só.
const jaLidos = new Map<string, { versao: string; campos: Promise<CamposDoXml | null> }>();

async function lerXmlAutorizado(caminho: string, versao: string, chave: string): Promise<CamposDoXml | null> {
  const guardado = jaLidos.get(caminho);
  if (guardado?.versao === versao) return guardado.campos;
  // Falha de leitura (arquivo preso, permissão) fica fora do cache: pode passar sem o arquivo mudar.
  const xml = await readFile(caminho, 'utf8');
  // Outra consulta pode ter começado o parse enquanto esta lia o arquivo.
  const emAndamento = jaLidos.get(caminho);
  if (emAndamento?.versao === versao) return emAndamento.campos;
  const campos = lerCamposDoXml(xml, chave).catch((err: unknown) => {
    avisar('XML não usado', chave, err);
    return null;
  });
  jaLidos.set(caminho, { versao, campos });
  return campos;
}

function mesDeEmissao(data: string | null): string | null {
  if (!data) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(data)) return data.slice(0, 7);
  const instante = new Date(data);
  return Number.isNaN(instante.getTime()) ? null : momentoSP(instante).dCompet.slice(0, 7);
}

async function montarNota(registro: Registro, outputDir: string): Promise<NotaListada | null> {
  const chave = registro.chave_acesso;
  let temXml = false;
  let doXml: CamposDoXml | null = null;
  // A chave vira nome de arquivo: só toca o disco com 50 dígitos.
  const chaveOk = chaveAcessoValida(chave);
  if (chaveOk) {
    try {
      const caminho = join(outputDir, 'autorizacao', `${chave}.xml`);
      const { mtimeMs, size } = await stat(caminho);
      temXml = true;
      doXml = await lerXmlAutorizado(caminho, `${mtimeMs}:${size}`, chave);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') avisar('XML não usado', chave, err);
    }
  }

  const competencia = doXml?.competencia
    ?? mesDeEmissao(registro.emitida_em)
    ?? mesDeEmissao(registro.data_venda);
  if (!competencia) {
    console.warn(`[notas] Nota sem data legível fora do Fechamento, nDPS ${registro.ndps}`);
    return null;
  }

  return {
    nNFSe: doXml?.nNFSe ?? null,
    ndps: registro.ndps,
    chave,
    emitidaEm: registro.emitida_em,
    competencia,
    competenciaEstimada: !doXml,
    tomador: doXml ? doXml.tomador : registro.nome,
    documentoMascarado: doXml ? doXml.documentoMascarado : mascaraDoc(registro.cpf_cnpj),
    // A coluna é REAL, mas o SQLite aceita texto: não pode virar NaN no total.
    valor: doXml ? doXml.valor : (typeof registro.valor === 'number' ? registro.valor : null),
    // Sem XML não há como saber o ambiente.
    homologacao: doXml?.homologacao ?? false,
    idVenda: registro.id_venda,
    temXml,
    temPdf: chaveOk && existsSync(join(outputDir, `danfse-${chave}.pdf`)),
  };
}

async function lerNotas(dbPath: string, outputDir: string): Promise<NotaListada[]> {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let registros: Registro[];
  try {
    registros = db.prepare(`
      SELECT n.chave_acesso, n.ndps, n.id_venda, n.emitida_em, v.valor, v.nome, v.cpf_cnpj, v.data_venda
      FROM notas n LEFT JOIN vendas v ON v.id_venda = n.id_venda
      ORDER BY n.emitida_em, n.ndps
    `).all() as unknown as Registro[];
  } finally {
    db.close();
  }
  const notas: NotaListada[] = [];
  for (const registro of registros) {
    const nota = await montarNota(registro, outputDir);
    if (nota) notas.push(nota);
  }
  return notas;
}

// Homologação não tem valor fiscal. Soma em centavos para o total não carregar resíduo binário.
function fechar(notas: NotaListada[]): { total: number; quantidade: number } {
  const fiscais = notas.filter((nota) => !nota.homologacao);
  const centavos = fiscais.reduce((soma, nota) => soma + Math.round((nota.valor ?? 0) * 100), 0);
  return { total: centavos / 100, quantidade: fiscais.length };
}

export async function listarCompetencias(dbPath: string, outputDir: string): Promise<CompetenciaResumo[]> {
  const porMes = new Map<string, NotaListada[]>();
  for (const nota of await lerNotas(dbPath, outputDir)) {
    const grupo = porMes.get(nota.competencia);
    if (grupo) grupo.push(nota);
    else porMes.set(nota.competencia, [nota]);
  }
  return [...porMes]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([competencia, notas]) => ({
      competencia,
      ...fechar(notas),
      estimada: notas.some((nota) => nota.competenciaEstimada),
    }));
}

export async function notasDaCompetencia(dbPath: string, outputDir: string, competencia: string) {
  const notas = (await lerNotas(dbPath, outputDir)).filter((nota) => nota.competencia === competencia);
  return { competencia, notas, ...fechar(notas) };
}
