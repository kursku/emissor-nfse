import { extrairDocumentosMascarados, mascararDocumentos } from './mascara.js';

const MAX_COMPLEMENTO = 300;
const MAX_DESCRICAO = 200;
const MAX_ID_DPS = 60;
const CODIGO_SEFIN_RE = /^[EA]\d{3,4}$/i;

export interface DiagnosticoSefin {
  codigo?: string;
  descricao?: string;
  complemento?: string;
  statusHttp?: number;
  idDPS?: string;
  nDPS?: string;
  documentos?: string[];
  itens?: ItemDiagnosticoSefin[];
}

export interface ItemDiagnosticoSefin {
  tipo: 'erro' | 'alerta';
  codigo?: string;
  descricao?: string;
}

export interface OpcoesDiagnosticoSefin {
  codigos?: readonly string[];
  nDPS?: string;
}

export function textoMensagemHttpSegura(valor: unknown): string {
  const raiz = comoRegistro(valor);
  const mensagem = raiz?.message;
  if (typeof mensagem !== 'string') return '';
  return /^HTTP\s+\d+/i.exec(mensagem)?.[0] ?? '';
}

function comoRegistro(valor: unknown): Record<string, unknown> | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

function textoOpcional(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : undefined;
}

function primeiroTexto(fontes: readonly Record<string, unknown>[], nomes: readonly string[]): string | undefined {
  for (const fonte of fontes) {
    for (const nome of nomes) {
      const valor = textoOpcional(fonte[nome]);
      if (valor) return valor;
    }
  }
  return undefined;
}

function codigoValido(valor: unknown): string | undefined {
  const texto = textoOpcional(valor);
  return texto && CODIGO_SEFIN_RE.test(texto) ? texto : undefined;
}

function primeiroCodigo(fontes: readonly Record<string, unknown>[]): string | undefined {
  for (const fonte of fontes) {
    const codigo = codigoValido(fonte.codigo);
    if (codigo) return codigo;
  }
  return undefined;
}

function textoSeguro(valor: unknown, limite: number): string | undefined {
  const texto = textoOpcional(valor);
  return texto ? mascararDocumentos(texto).slice(0, limite) : undefined;
}

function textoMensagemLocalSegura(valor: unknown): string {
  const raiz = comoRegistro(valor);
  const mensagem = typeof valor === 'string' ? valor : raiz?.message;
  return textoSeguro(mensagem, MAX_COMPLEMENTO) ?? '';
}

function possuiEnvelopeSefin(valor: unknown): boolean {
  const raiz = comoRegistro(valor);
  return raiz !== null && (raiz.nfseErrorDetail !== undefined || raiz.response !== undefined);
}

function primeiroNumero(fontes: readonly Record<string, unknown>[], nome: string): number | undefined {
  for (const fonte of fontes) {
    if (typeof fonte[nome] === 'number') return fonte[nome];
  }
  return undefined;
}

function documentosMascarados(fontes: readonly Record<string, unknown>[]): string[] {
  const documentos = new Set<string>();
  for (const fonte of fontes) {
    for (const valor of Object.values(fonte)) {
      if (typeof valor !== 'string') continue;
      for (const documento of extrairDocumentosMascarados(valor)) documentos.add(documento);
    }
  }
  return [...documentos];
}

function extrairItensRaw(raw: unknown): ItemDiagnosticoSefin[] {
  const registro = comoRegistro(raw);
  if (!registro) return [];
  const itens: ItemDiagnosticoSefin[] = [];
  const listas: Array<['erro' | 'alerta', string[]]> = [
    ['erro', ['erros', 'Erros']],
    ['alerta', ['alertas', 'Alertas']],
  ];
  for (const [tipo, nomes] of listas) {
    for (const nome of nomes) {
      const valores = registro[nome];
      if (!Array.isArray(valores)) continue;
      for (const valor of valores) {
        const item = comoRegistro(valor);
        if (!item) continue;
        const codigo = codigoValido(item.codigo ?? item.Codigo);
        const descricao = textoSeguro(
          item.descricao ?? item.Descricao ?? item.mensagem ?? item.message,
          MAX_DESCRICAO,
        );
        if (codigo || descricao) itens.push({ tipo, ...(codigo ? { codigo } : {}), ...(descricao ? { descricao } : {}) });
        if (itens.length === 5) return itens;
      }
    }
  }
  return itens;
}

export function extrairDiagnosticoSefin(
  valor: unknown,
  opcoes: OpcoesDiagnosticoSefin = {},
): DiagnosticoSefin | null {
  const raiz = comoRegistro(valor);
  if (!raiz) return opcoes.nDPS ? { nDPS: opcoes.nDPS } : null;

  const detalhe = comoRegistro(raiz.nfseErrorDetail);
  const resposta = comoRegistro(raiz.response);
  const dadosResposta = comoRegistro(resposta?.data);
  const fontes = [detalhe, dadosResposta, raiz, resposta].filter(
    (fonte): fonte is Record<string, unknown> => fonte !== null,
  );
  const codigo = primeiroCodigo(fontes) ?? opcoes.codigos?.map(codigoValido).find(Boolean);
  const descricao = textoSeguro(primeiroTexto(fontes, ['descricao']), MAX_DESCRICAO);
  const complemento = textoSeguro(primeiroTexto(fontes, ['complemento']), MAX_COMPLEMENTO);
  const idDPS = textoSeguro(primeiroTexto(fontes, ['idDPS', 'idDps']), MAX_ID_DPS);
  const itens = extrairItensRaw(detalhe?.raw);
  const documentos = documentosMascarados(fontes);
  const diagnostico: DiagnosticoSefin = {
    ...(codigo ? { codigo } : {}),
    ...(descricao ? { descricao } : {}),
    ...(complemento ? { complemento } : {}),
    ...(primeiroNumero(fontes, 'statusHttp') !== undefined
      ? { statusHttp: primeiroNumero(fontes, 'statusHttp') }
      : {}),
    ...(idDPS ? { idDPS } : {}),
    ...(opcoes.nDPS ? { nDPS: opcoes.nDPS } : {}),
    ...(documentos.length > 0 ? { documentos } : {}),
    ...(itens.length > 0 ? { itens } : {}),
  };

  return Object.keys(diagnostico).length > 0 ? diagnostico : null;
}

export function textoDiagnosticoSefin(diagnostico: DiagnosticoSefin): string {
  return mascararDocumentos([
    diagnostico.codigo && `codigo=${diagnostico.codigo}`,
    diagnostico.descricao && `descricao=${diagnostico.descricao}`,
    diagnostico.complemento && `complemento=${diagnostico.complemento}`,
    diagnostico.statusHttp !== undefined && `statusHttp=${diagnostico.statusHttp}`,
    diagnostico.nDPS && `nDPS=${diagnostico.nDPS}`,
    diagnostico.idDPS && `idDPS=${diagnostico.idDPS}`,
    diagnostico.documentos && `documentos=${diagnostico.documentos.join(', ')}`,
    diagnostico.itens && `itens=${diagnostico.itens.map((item) => [
      item.tipo,
      item.codigo && `codigo=${item.codigo}`,
      item.descricao && `descricao=${item.descricao}`,
    ].filter(Boolean).join(', ')).join(' | ')}`,
  ].filter(Boolean).join('; '));
}

export function textoErroSefin(
  valor: unknown,
  opcoes: OpcoesDiagnosticoSefin = {},
): string {
  const diagnostico = extrairDiagnosticoSefin(valor, opcoes);
  const mensagemHttp = textoMensagemHttpSegura(valor);
  const resumo = diagnostico ? textoDiagnosticoSefin(diagnostico) : '';
  if (possuiEnvelopeSefin(valor) || mensagemHttp || opcoes.codigos?.some(codigoValido)) {
    return [resumo, mensagemHttp].filter(Boolean).join('; ');
  }
  return [resumo, textoMensagemLocalSegura(valor)].filter(Boolean).join('; ');
}
