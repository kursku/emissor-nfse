import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

const LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export interface LockFilaReal {
  liberar(): void;
  confirmar(): boolean;
}

export interface OpcoesLockFilaReal {
  pid?: number;
  agora?: Date;
  heartbeatMs?: number;
  agendarHeartbeat?: (callback: () => void, intervalo: number) => NodeJS.Timeout;
  avisar?: (mensagem: string) => void;
  tocar?: (path: string, agora: Date) => void;
}

type AgendarHeartbeat = (callback: () => void, intervalo: number) => NodeJS.Timeout;

function criarArquivoAtomico(path: string, conteudo: string): boolean {
  const temporario = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporario, conteudo, { encoding: 'utf8', flag: 'wx' });
    linkSync(temporario, path);
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(temporario); } catch { /* temporário já pode ter sido removido */ }
  }
}

function nomeAbandonado(path: string): string {
  return `${path}.abandonado-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

interface EstadoHeartbeat {
  falhasSeguidas: number;
  desistiu: boolean;
}

function iniciarHeartbeat(
  path: string,
  conteudo: string,
  intervalo: number,
  tocar: (path: string, agora: Date) => void,
  avisar: (mensagem: string) => void,
  estado: EstadoHeartbeat,
  agendar: AgendarHeartbeat,
): NodeJS.Timeout {
  let timer: NodeJS.Timeout;
  const falhar = (): void => {
    estado.falhasSeguidas++;
    if (estado.falhasSeguidas < 3) return;
    estado.desistiu = true;
    clearInterval(timer);
    avisar('Heartbeat do lock da fila real falhou 3 vezes seguidas; desistindo.');
  };

  timer = agendar(() => {
    if (estado.desistiu) return;
    try {
      if (readFileSync(path, 'utf8') !== conteudo) throw new Error('conteúdo do lock mudou');
      tocar(path, new Date());
      estado.falhasSeguidas = 0;
    } catch {
      falhar();
    }
  }, intervalo);
  timer.unref();
  return timer;
}

export function adquirirLockFilaReal(
  path: string,
  opcoes: OpcoesLockFilaReal = {},
): LockFilaReal | null {
  const pid = opcoes.pid ?? process.pid;
  const agora = opcoes.agora ?? new Date();
  const avisar = opcoes.avisar ?? ((mensagem) => console.warn(mensagem));
  const heartbeatMs = opcoes.heartbeatMs ?? 30_000;
  const tocar = opcoes.tocar ?? ((arquivo, data) => utimesSync(arquivo, data, data));
  const agendarHeartbeat: AgendarHeartbeat = opcoes.agendarHeartbeat
    ?? ((callback, intervalo) => setInterval(callback, intervalo));
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > LOCK_MAX_AGE_MS / 3) {
    throw new Error(`heartbeatMs deve ser um inteiro positivo de no máximo ${LOCK_MAX_AGE_MS / 3} ms.`);
  }
  const criadoEm = agora.toISOString();
  const conteudo = JSON.stringify({ pid, criadoEm });

  if (existsSync(path)) {
    let estatisticas: ReturnType<typeof statSync>;
    let conteudoAnterior: string;
    try {
      estatisticas = statSync(path);
      conteudoAnterior = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    if (agora.getTime() - estatisticas.mtimeMs <= LOCK_MAX_AGE_MS) return null;

    const abandonado = nomeAbandonado(path);
    try {
      renameSync(path, abandonado);
    } catch {
      return null;
    }

    let igual = false;
    try {
      const movido = statSync(abandonado);
      igual = movido.mtimeMs === estatisticas.mtimeMs && readFileSync(abandonado, 'utf8') === conteudoAnterior;
    } catch {
      igual = false;
    }
    if (!igual) {
      try { renameSync(abandonado, path); } catch { /* outro processo ganhou o caminho */ }
      return null;
    }

    avisar(`Lock da fila real abandonado; substituindo o lock antigo.`);
    if (!criarArquivoAtomico(path, conteudo)) {
      try { unlinkSync(abandonado); } catch { /* limpeza best-effort do lock antigo */ }
      return null;
    }
    try { unlinkSync(abandonado); } catch { /* o arquivo já foi isolado */ }
  } else if (!criarArquivoAtomico(path, conteudo)) {
    return null;
  }

  const estadoHeartbeat: EstadoHeartbeat = { falhasSeguidas: 0, desistiu: false };
  const heartbeat = iniciarHeartbeat(
    path,
    conteudo,
    heartbeatMs,
    tocar,
    avisar,
    estadoHeartbeat,
    agendarHeartbeat,
  );
  return {
    confirmar(): boolean {
      if (estadoHeartbeat.desistiu) return false;
      try {
        const estatisticas = statSync(path);
        if (readFileSync(path, 'utf8') !== conteudo) return false;
        if (estatisticas.mtimeMs <= Date.now() - LOCK_MAX_AGE_MS) return false;
        tocar(path, new Date());
        estadoHeartbeat.falhasSeguidas = 0;
        return true;
      } catch {
        return false;
      }
    },
    liberar(): void {
      clearInterval(heartbeat);
      try {
        if (readFileSync(path, 'utf8') === conteudo) unlinkSync(path);
      } catch {
        // O lock pode ter sido removido por uma tomada concorrente.
      }
    },
  };
}
