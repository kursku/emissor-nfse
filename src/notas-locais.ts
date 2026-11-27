/**
 * Modelo de leitura das Notas: registro do banco + Venda + XML autorizado local.
 * Só lê: abre o banco como somente leitura e não grava arquivo.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

type CamposDoXml = Pick<NotaListada, 'nNFSe' | 'competencia' | 'tomador' | 'documentoMascarado' | 'valor'>;

// O parser da lib decodifica só as entidades nomeadas; referências numéricas ficariam cruas.
function decodificarReferencias(xml: string): string {
  return xml.replace(/&#(x[0-9a-f]+|\d+);/gi, (referencia, codigo: string) => {
    const ponto = /^x/i.test(codigo) ? parseInt(codigo.slice(1), 16) : Number(codigo);
    if (ponto === 0x26) return '&amp;';
    if (ponto === 0x3c) return '&lt;';
    return ponto <= 0x10ffff ? String.fromCodePoint(ponto) : referencia;
  });
}

/** O parser do DANFSe devolve texto formatado para impressão; aqui volta a ser dado. */
async function lerCamposDoXml(xml: string, chave: string): Promise<CamposDoXml> {
  const dados = await parseDanfse(decodificarReferencias(xml));
  if (dados.chaveAcesso !== chave) throw new Error('chave do XML diverge da Nota');
  const data = /^\d{2}\/(\d{2})\/(\d{4})$/.exec(dados.dCompet);
  if (!data) throw new Error('dCompet ausente ou inválida');
  return {
    nNFSe: dados.nNFSe,
    competencia: `${data[2]}-${data[1]}`,
    // shortcut: o parser corta nomes acima de 80 caracteres; ler o XML direto se isso incomodar.
    // XML sem <toma> é válido: o parser devolve tomador nulo.
    tomador: !dados.tomador || dados.tomador.xNome === '-' ? null : dados.tomador.xNome,
    documentoMascarado: mascaraDoc(dados.tomador?.doc),
    valor: parseValorMonetario(dados.vServ.replace(/^R\$\s*/, '')),
  };
}

// Cada parse custa alguns ms e toda consulta passa por todos os XMLs: guarda enquanto o arquivo não muda.
const jaLidos = new Map<string, { versao: string; campos: CamposDoXml }>();

async function lerXmlAutorizado(caminho: string, versao: string, chave: string): Promise<CamposDoXml> {
  const guardado = jaLidos.get(caminho);
  if (guardado?.versao === versao) return guardado.campos;
  const campos = await lerCamposDoXml(await readFile(caminho, 'utf8'), chave);
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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const motivo = err instanceof Error ? err.message : String(err);
        console.warn(mascararDocumentos(`[notas] XML não usado, chave ${chave}: `) + mascararDocumentos(motivo));
      }
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

// Soma em centavos para o total não carregar resíduo binário.
function somar(notas: NotaListada[]): number {
  return notas.reduce((centavos, nota) => centavos + Math.round((nota.valor ?? 0) * 100), 0) / 100;
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
      total: somar(notas),
      quantidade: notas.length,
      estimada: notas.some((nota) => nota.competenciaEstimada),
    }));
}

export async function notasDaCompetencia(dbPath: string, outputDir: string, competencia: string) {
  const notas = (await lerNotas(dbPath, outputDir)).filter((nota) => nota.competencia === competencia);
  return { competencia, notas, total: somar(notas), quantidade: notas.length };
}
