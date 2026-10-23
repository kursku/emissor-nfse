import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adquirirLockFilaReal } from "./fila-lock.js";
import { initDb, reservarEmissao, upsertVenda } from "./store.js";

test("duas execuções reais concorrentes chamam o emissor uma só vez", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-"));
  const caminho = join(root, ".fila-real.lock");
  initDb(join(root, "emissor.db"));
  upsertVenda({ id_venda: "venda-concorrente", produto: "teste", fila: "pronta", status: "pronta" });
  let chamadas = 0;

  const executar = async (): Promise<void> => {
    const lock = adquirirLockFilaReal(caminho, { pid: process.pid });
    if (!lock) return;
    try {
      if (reservarEmissao("venda-concorrente", root)) chamadas++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      lock.liberar();
    }
  };

  await Promise.all([executar(), executar()]);
  assert.equal(chamadas, 1);
});

test("dono com heartbeat recente não é substituído pela idade do pid", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-abandonado-"));
  const caminho = join(root, ".fila-real.lock");
  const criadoEm = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(caminho, JSON.stringify({ pid: 999999, criadoEm }));
  const agora = new Date();
  utimesSync(caminho, agora, agora);
  const avisos: string[] = [];

  const lock = adquirirLockFilaReal(caminho, {
    pid: process.pid,
    avisar: (aviso) => avisos.push(aviso),
  });

  assert.equal(lock, null);
  assert.deepEqual(avisos, []);
});

test("lock vazio recente é considerado ocupado", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-vazio-"));
  const caminho = join(root, ".fila-real.lock");
  writeFileSync(caminho, "");
  const agora = new Date();
  utimesSync(caminho, agora, agora);

  assert.equal(adquirirLockFilaReal(caminho), null);
});

test("lock com heartbeat parado é tomado atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-tomada-"));
  const caminho = join(root, ".fila-real.lock");
  writeFileSync(caminho, JSON.stringify({ pid: 999999, criadoEm: new Date().toISOString() }));
  const antigo = new Date(Date.now() - 6 * 60 * 1000);
  utimesSync(caminho, antigo, antigo);
  const avisos: string[] = [];

  const lock = adquirirLockFilaReal(caminho, { avisar: (aviso) => avisos.push(aviso) });

  assert.ok(lock);
  assert.match(avisos[0] ?? "", /abandonado/i);
  assert.match(readFileSync(caminho, 'utf8'), /"pid"/);
  lock.liberar();
});

test("heartbeat renova o mtime do lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-heartbeat-"));
  const caminho = join(root, ".fila-real.lock");
  const lock = adquirirLockFilaReal(caminho, { heartbeatMs: 10 });
  assert.ok(lock);
  const antes = statSync(caminho).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(statSync(caminho).mtimeMs > antes);
  lock.liberar();
});

test("heartbeat continua depois de uma falha transitória e confirmar renova o lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-heartbeat-transitorio-"));
  const caminho = join(root, ".fila-real.lock");
  let toques = 0;
  let executarHeartbeat: (() => void) | undefined;
  const timer = setInterval(() => {}, 60_000);
  timer.unref();
  const lock = adquirirLockFilaReal(caminho, {
    heartbeatMs: 5,
    agendarHeartbeat: (callback) => {
      executarHeartbeat = callback;
      return timer;
    },
    tocar: () => {
      toques++;
      if (toques === 1) throw new Error("falha transitória");
      utimesSync(caminho, new Date(), new Date());
    },
  });
  assert.ok(lock);
  assert.ok(executarHeartbeat);
  executarHeartbeat();
  executarHeartbeat();
  assert.equal(toques, 2);
  assert.equal(lock.confirmar(), true);
  lock.liberar();
});

test("fencing confirma que o conteúdo do lock ainda é do dono", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-fencing-"));
  const caminho = join(root, ".fila-real.lock");
  const lock = adquirirLockFilaReal(caminho);
  assert.ok(lock);
  assert.equal(lock.confirmar(), true);

  writeFileSync(caminho, JSON.stringify({ pid: 999999, criadoEm: new Date().toISOString() }));
  assert.equal(lock.confirmar(), false);
  lock.liberar();
});

test("heartbeatMs é inteiro positivo e no máximo um terço da idade de abandono", () => {
  const root = mkdtempSync(join(tmpdir(), "nfse-fila-lock-heartbeat-invalido-"));
  const caminho = join(root, ".fila-real.lock");

  for (const heartbeatMs of [0, -1, 1.5, 100_001, Number.POSITIVE_INFINITY]) {
    assert.throws(() => adquirirLockFilaReal(caminho, { heartbeatMs }), /heartbeatMs/i);
  }
});
