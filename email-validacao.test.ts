/**
 * Testes do helper puro de email-validacao.ts: erroEnvioEmail, os
 * pré-requisitos que enviarEmailNota checa antes de qualquer chamada de
 * rede. Testado via email-validacao.ts diretamente — importar email.ts
 * puxa config.ts (via http-mtls.ts), que exige NFSE_* no ambiente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { erroEnvioEmail } from "./email-validacao.js";

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
