/**
 * Testes do helper puro de email-validacao.ts: erroEnvioEmail, os
 * pré-requisitos que enviarEmailNota checa antes de qualquer chamada de
 * rede. Testado via email-validacao.ts diretamente — importar email.ts
 * puxa config.ts (via http-mtls.ts), que exige NFSE_* no ambiente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { erroEnvioEmail, montarHtmlNota } from "./email-validacao.js";

test("erroEnvioEmail acusa venda sem e-mail antes de checar credenciais", () => {
  assert.equal(
    erroEnvioEmail({ email: undefined, apiKey: "chave", from: "nfse@exemplo.com" }),
    "venda sem e-mail",
  );
});

test("erroEnvioEmail acusa RESEND_API_KEY ausente quando o e-mail existe", () => {
  assert.equal(
    erroEnvioEmail({ email: "cliente@exemplo.com.br", apiKey: undefined, from: "nfse@exemplo.com" }),
    "RESEND_API_KEY ausente",
  );
});

test("erroEnvioEmail recusa destinatario que nao segue a regra estrita", () => {
  for (const email of [
    "cliente",
    "cliente@",
    "cliente @exemplo.com",
    "cliente@exemplo",
    "cliente@exemplo.com\nBcc: atacante@exemplo.com",
  ]) {
    assert.equal(
      erroEnvioEmail({ email, apiKey: "chave", from: "nfse@exemplo.com" }),
      "venda com e-mail inválido",
      email,
    );
  }
});

test("erroEnvioEmail acusa remetente ausente quando e-mail e chave existem", () => {
  assert.equal(
    erroEnvioEmail({ email: "cliente@exemplo.com.br", apiKey: "chave", from: undefined }),
    "RESEND_FROM_NOTAS/RESEND_FROM ausente",
  );
});

test("erroEnvioEmail retorna null quando todos os pre-requisitos estao presentes", () => {
  assert.equal(
    erroEnvioEmail({ email: "cliente@exemplo.com.br", apiKey: "chave", from: "nfse@exemplo.com" }),
    null,
  );
});

test("montarHtmlNota escapa nome do Tomador antes de montar o corpo", () => {
  const html = montarHtmlNota('<img src=x onerror="alert(1)">', "chave-1", false);

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|onerror="/);
});
