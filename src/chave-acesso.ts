import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Regras comuns para identificar uma Chave de acesso devolvida pela lib. */

export interface ArquivoXmlAutorizado {
  nome: string;
  conteudo: string;
}

export const MENSAGEM_CHAVE_A_VERIFICAR =
  "Chave de acesso ausente ou inválida após a autorização; conciliação manual necessária.";

export type DecisaoRespostaEmissao =
  | { estado: "rejeitada"; mensagem: string; codigos: string[] }
  | { estado: "autorizada"; chave: string; codigos: string[] }
  | { estado: "sucesso_sem_chave" };

const CHAVE_ACESSO_RE = /^\d{50}$/;
const NDPS_XML_RE = /<(?:(?:[\w.-]+):)?nDPS\b[^>]*>\s*([^<]*?)\s*<\/(?:(?:[\w.-]+):)?nDPS\s*>/i;
const CODIGO_SEFIN_RE = /\bE\d{4}\b/gi;

function comoRegistro(valor: unknown): Record<string, unknown> | null {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

export function chaveAcessoValida(valor: unknown): valor is string {
  return typeof valor === "string" && CHAVE_ACESSO_RE.test(valor);
}

/**
 * A biblioteca usa chNFSe em algumas respostas e chaveAcesso em outras.
 * Algumas versões ainda envolvem a resposta HTTP em `response`.
 */
export function extrairChaveAcesso(resultado: unknown): string | null {
  const raiz = comoRegistro(resultado);
  if (!raiz) return null;

  const objetos = [raiz, comoRegistro(raiz.response)];
  for (const objeto of objetos) {
    if (!objeto) continue;
    for (const nome of ["chNFSe", "chaveAcesso"] as const) {
      if (chaveAcessoValida(objeto[nome])) return objeto[nome];
    }
  }
  return null;
}

function valorNaoVazio(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === "boolean") return valor;
  if (typeof valor === "string") return valor.trim() !== "";
  if (Array.isArray(valor)) return valor.length > 0;
  if (typeof valor === "object") return Object.keys(valor).length > 0;
  return true;
}

function campoIndicaErro(nome: string): boolean {
  const normalizado = nome.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  return [
    "erro",
    "erros",
    "error",
    "errors",
    "mensagemerro",
    "mensagenserro",
    "mensagensdeerro",
    "rejeicao",
    "rejeicoes",
    "rejected",
    "rejeitada",
    "falha",
    "falhas",
    "errormessage",
    "errormessages",
  ].includes(normalizado);
}

function mensagemRejeicao(codigos: readonly string[]): string {
  if (codigos.length > 0) return `Resposta rejeitada pela SEFIN; códigos: ${codigos.join(", ")}.`;
  return "Resposta rejeitada pela SEFIN; conciliação manual necessária.";
}

/** Classifica a resposta antes de permitir qualquer fallback em arquivo. */
export function classificarRespostaEmissao(resultado: unknown): DecisaoRespostaEmissao {
  const codigos = new Set<string>();
  let rejeitada = false;
  const visitados = new WeakSet<object>();

  const visitar = (valor: unknown, nome?: string): void => {
    if (typeof valor === "string") {
      for (const codigo of valor.match(CODIGO_SEFIN_RE) ?? []) codigos.add(codigo.toUpperCase());
    }
    if (nome?.toLowerCase() === "cstat" && valorNaoVazio(valor) && String(valor).trim() !== "100") {
      rejeitada = true;
    }
    if (nome !== undefined && campoIndicaErro(nome) && valorNaoVazio(valor)) rejeitada = true;
    if (nome?.toLowerCase() === "codigo" && typeof valor === "string" && /^E\d{4}$/i.test(valor.trim())) {
      rejeitada = true;
    }
    if (typeof valor !== "object" || valor === null) return;
    if (visitados.has(valor)) return;
    visitados.add(valor);
    if (Array.isArray(valor)) {
      for (const item of valor) visitar(item);
      return;
    }
    for (const [chave, item] of Object.entries(valor)) visitar(item, chave);
  };

  visitar(resultado);
  const chave = extrairChaveAcesso(resultado);
  if (chave !== null) {
    return { estado: "autorizada", chave, codigos: [...codigos] };
  }

  if (rejeitada) {
    return {
      estado: "rejeitada",
      mensagem: mensagemRejeicao([...codigos]),
      codigos: [...codigos],
    };
  }

  return { estado: "sucesso_sem_chave" };
}

function ndpsDoXml(conteudo: string): string | null {
  return NDPS_XML_RE.exec(conteudo)?.[1]?.trim() ?? null;
}

function codigoDoErro(erro: unknown): unknown {
  if (typeof erro !== "object" || erro === null) return undefined;
  return (erro as { code?: unknown }).code;
}

/** Encontra a chave pelo nDPS enviado, sem depender da data do arquivo. */
export function encontrarChaveNoXmlAutorizado(
  arquivos: readonly ArquivoXmlAutorizado[],
  ndps: string,
): string | null {
  const ndpsEnviado = ndps.trim();
  if (ndpsEnviado === "") return null;

  const correspondentes: string[] = [];
  for (const arquivo of arquivos) {
    const chave = arquivo.nome.replace(/\.xml$/i, "");
    if (!chaveAcessoValida(chave)) continue;
    if (ndpsDoXml(arquivo.conteudo) === ndpsEnviado) correspondentes.push(chave);
  }
  return correspondentes.length === 1 ? correspondentes[0] : null;
}

/** Lê os XMLs autorizados e só ignora a ausência da pasta ou de um arquivo. */
export function buscarChaveNoXmlPorNdps(outputDir: string, ndps: string): string | null {
  const autorizacaoDir = join(outputDir, "autorizacao");
  let nomes: string[];
  try {
    nomes = readdirSync(autorizacaoDir).filter((nome) => nome.toLowerCase().endsWith(".xml"));
  } catch (erro) {
    if (codigoDoErro(erro) === "ENOENT") return null;
    throw erro;
  }

  const arquivos: ArquivoXmlAutorizado[] = [];
  for (const nome of nomes) {
    try {
      arquivos.push({ nome, conteudo: readFileSync(join(autorizacaoDir, nome), "utf8") });
    } catch (erro) {
      if (codigoDoErro(erro) === "ENOENT") continue;
      throw erro;
    }
  }
  return encontrarChaveNoXmlAutorizado(arquivos, ndps);
}
