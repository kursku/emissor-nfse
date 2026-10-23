# Auditoria de dependências

Em 2026-10-21, a árvore travada foi auditada online com Node 24. O comando de
correção foi:

```text
fnm exec --using=24 -- npm.cmd audit fix
```

O comando não usou `--force` nem alterou a versão major de uma dependência
direta. Foram atualizados oito pacotes transitivos:

- `@xmldom/xmldom`: 0.8.13 → 0.8.15
- `axios`: 1.18.1 → 1.20.0
- `brace-expansion`: 2.1.4 → 2.1.7
- `follow-redirects`: 1.16.0 → 1.16.1
- `http-cache-semantics`: 4.2.0 → 4.3.0
- `ip-address`: 10.4.0 → 10.7.4
- `proxy-addr`: 2.0.7 → 2.0.8
- `qs`: 6.15.3 → 6.16.1

## Resultado online

O resultado usado para a promoção foi obtido com:

```text
fnm exec --using=24 -- npm.cmd audit --omit=dev
```

O comando encontrou 3 vulnerabilidades high em dependências de produção. Não
há advisories corrigíveis restantes: todas pertencem à mesma advisory sem
correção disponível upstream.

A troca para `@nfewizard/nfse` 1.0.7 atualizou a cadeia para
`@nfewizard/shared` 1.1.7 e `@nfewizard/types` 1.0.11, mas não alterou o
resultado da auditoria. A biblioteca usa `node-forge` apenas para ler o
certificado `.p12` e converter certificados; não o usa para verificar
assinaturas.

| Pacote | Versão | Severidade | Motivo da pendência |
| --- | --- | --- | --- |
| `node-forge` | 1.4.0 | high | A advisory GHSA-86w9-cpqp-85rv trata da aceitação de elementos `DigestAlgorithm` aninhados extras na verificação de assinaturas RSA PKCS#1 v1.5. O npm informa `No fix available`; o pacote é trazido por `@nfewizard/shared`. |
| `@nfewizard/shared` | 1.1.7 | high | Dependência transitiva afetada por `node-forge`; não há versão upstream corrigida disponível. |
| `@nfewizard/nfse` | 1.0.7 | high | Dependência direta que fixa a cadeia afetada por `@nfewizard/shared`; não há versão upstream corrigida disponível. |

O relatório JSON correspondente registrou `3 high`, `0 moderate`, `0 low` e
`0 critical` para produção, com `fixAvailable: false` nos três nós. O comando
retorna código 1 por causa dessas vulnerabilidades sem correção, mas não há
correção automática adicional a aplicar sem trocar a dependência upstream.
