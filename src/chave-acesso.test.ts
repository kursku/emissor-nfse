import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  classificarRespostaEmissao,
  extrairChaveAcesso,
  buscarChaveNoXmlPorNdps,
  encontrarChaveNoXmlAutorizado,
} from "./chave-acesso.js";

const CHAVE = "1234567890".repeat(5);

test("extrairChaveAcesso reconhece chNFSe com 50 dígitos", () => {
  assert.equal(extrairChaveAcesso({ chNFSe: CHAVE }), CHAVE);
});

test("extrairChaveAcesso reconhece chaveAcesso no envelope da lib", () => {
  assert.equal(extrairChaveAcesso({ response: { chaveAcesso: CHAVE } }), CHAVE);
});

test("extrairChaveAcesso rejeita chave ausente ou que não tenha 50 dígitos", () => {
  assert.equal(extrairChaveAcesso({}), null);
  assert.equal(extrairChaveAcesso({ chaveAcesso: `SIM-1-venda` }), null);
  assert.equal(extrairChaveAcesso({ chNFSe: CHAVE.slice(0, 49) }), null);
});

test("classificarRespostaEmissao prioriza Chave válida sobre mensagens informativas", () => {
  const respostas = [
    { chNFSe: CHAVE, mensagens: ["E0001 alerta"] },
    { response: { chaveAcesso: CHAVE }, alertas: [{ codigo: "E0002" }] },
    { chaveAcesso: CHAVE, erros: [{ codigo: "E0003" }] },
  ];

  for (const resposta of respostas) {
    const decisao = classificarRespostaEmissao(resposta);
    assert.equal(decisao.estado, "autorizada");
    if (decisao.estado === "autorizada") assert.equal(decisao.chave, CHAVE);
  }
});

test("classificarRespostaEmissao rejeita cStat diferente de 100 e erros não vazios", () => {
  for (const resposta of [{ cStat: "101" }, { erros: [{ codigo: "E0234" }] }]) {
    const decisao = classificarRespostaEmissao(resposta);
    assert.equal(decisao.estado, "rejeitada");
  }
});

test("classificarRespostaEmissao separa autorização com chave de sucesso sem chave", () => {
  assert.deepEqual(classificarRespostaEmissao({ chaveAcesso: CHAVE }), {
    estado: "autorizada",
    chave: CHAVE,
    codigos: [],
  });
  assert.equal(classificarRespostaEmissao({ ok: true }).estado, "sucesso_sem_chave");
});

test("código em campo de aviso sem Chave não vira rejeição", () => {
  assert.equal(
    classificarRespostaEmissao({ mensagens: ["E0001 aviso"] }).estado,
    "sucesso_sem_chave",
  );
});

test("classificarRespostaEmissao reconhece o envelope de autorização da lib 1.0.7", () => {
  const autorizado = classificarRespostaEmissao({
    success: true,
    status: 200,
    response: {
      tipoAmbiente: 2,
      chaveAcesso: CHAVE,
      cStat: "100",
      nNFSe: "42",
      dhProc: "2026-10-21T12:00:00-03:00",
    },
  });
  assert.deepEqual(autorizado, {
    estado: "autorizada",
    chave: CHAVE,
    codigos: [],
  });

  const rejeitada = classificarRespostaEmissao({
    success: false,
    status: 400,
    response: {
      cStat: "103",
      nNFSe: "42",
      dhProc: "2026-10-21T12:00:00-03:00",
      erros: [{ codigo: "E1235", descricao: "DPS rejeitada" }],
    },
  });
  assert.deepEqual(rejeitada, {
    estado: "rejeitada",
    mensagem: "Resposta rejeitada pela SEFIN; códigos: E1235.",
    codigos: ["E1235"],
  });

  assert.equal(
    classificarRespostaEmissao({
      success: true,
      status: 200,
      response: { cStat: "100", nNFSe: "42", dhProc: "2026-10-21T12:00:00-03:00" },
    }).estado,
    "sucesso_sem_chave",
  );
});

test("código em campo codigo continua indicando rejeição", () => {
  assert.equal(classificarRespostaEmissao({ codigo: "E0116" }).estado, "rejeitada");
});

test("campos booleanos rejeitado e rejeitada falsos não indicam erro", () => {
  assert.equal(classificarRespostaEmissao({ rejected: false, rejeitada: false }).estado, "sucesso_sem_chave");
});

test("código SEFIN minúsculo é rejeição e entra normalizado em codigos", () => {
  assert.deepEqual(classificarRespostaEmissao({ codigo: "e0116" }), {
    estado: "rejeitada",
    mensagem: "Resposta rejeitada pela SEFIN; códigos: E0116.",
    codigos: ["E0116"],
  });
});

test("encontrarChaveNoXmlAutorizado ignora XML de nDPS divergente", () => {
  const divergente = `<NFSe><infDPS><nDPS>99</nDPS></infDPS></NFSe>`;
  const correto = `<NFSe><infDPS><nDPS>42</nDPS></infDPS></NFSe>`;

  assert.equal(
    encontrarChaveNoXmlAutorizado(
      [
        { nome: `${CHAVE}.xml`, conteudo: divergente },
        { nome: `${"9".repeat(50)}.xml`, conteudo: correto },
      ],
      "42",
    ),
    "9".repeat(50),
  );
});

test("encontrarChaveNoXmlAutorizado não escolhe o primeiro XML em ambiguidade", () => {
  assert.equal(
    encontrarChaveNoXmlAutorizado(
      [
        { nome: `${CHAVE}.xml`, conteudo: "<nDPS>42</nDPS>" },
        { nome: `${"9".repeat(50)}.xml`, conteudo: "<nDPS>42</nDPS>" },
      ],
      "42",
    ),
    null,
  );
});

test("encontrarChaveNoXmlAutorizado não aceita arquivo sem nDPS correspondente", () => {
  assert.equal(
    encontrarChaveNoXmlAutorizado(
      [{ nome: `${CHAVE}.xml`, conteudo: "<NFSe><nDPS>7</nDPS></NFSe>" }],
      "42",
    ),
    null,
  );
});

test("buscarChaveNoXmlPorNdps encontra o único XML autorizado do nDPS", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "nfse-chave-"));
  const autorizacao = join(outputDir, "autorizacao");
  await mkdir(autorizacao);

  try {
    await writeFile(
      join(autorizacao, `${CHAVE}.xml`),
      "<NFSe><infDPS><nDPS>42</nDPS></infDPS></NFSe>",
    );
    assert.equal(buscarChaveNoXmlPorNdps(outputDir, "42"), CHAVE);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("buscarChaveNoXmlPorNdps trata diretório ausente como sem XML", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "nfse-chave-"));

  try {
    assert.equal(buscarChaveNoXmlPorNdps(outputDir, "42"), null);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("buscarChaveNoXmlPorNdps propaga erro de filesystem que não seja ENOENT", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "nfse-chave-"));

  try {
    await writeFile(join(outputDir, "autorizacao"), "não é um diretório");
    assert.throws(
      () => buscarChaveNoXmlPorNdps(outputDir, "42"),
      /ENOTDIR|not a directory|directory/i,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
