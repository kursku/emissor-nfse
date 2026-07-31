# Tickets — caminho até a primeira nota

Este arquivo é o roteiro de execução até a primeira NFS-e emitida de verdade
por esta operadora. A ordem da lista é a ordem de execução — não pule
tickets, mesmo que pareçam rápidos. Cada ticket é marcado como **HITL**
(precisa de uma troca de informação com a operadora, algo que nenhum agente
pode inventar) ou **AFK** (o agente resolve sozinho, sem depender de uma
resposta nova dela). A maior parte do trabalho que falta não é código — é
informação e decisão que só ela pode fornecer.

## T1 — Obter o certificado digital A1 e-CNPJ

- Tipo: HITL
- Bloqueado por: —
- Pronto quando: existe um arquivo `.p12` no disco e a senha do certificado é conhecida.

Comprar numa Autoridade Certificadora credenciada pela ICP-Brasil (Serasa,
Certisign, Valid, entre outras), pedindo explicitamente "e-CNPJ A1, arquivo
.p12". Validade de um ano. Certificado A3 (cartão ou token USB) não serve
para automação, porque a chave privada fica presa no dispositivo físico. Este
é o único ticket com compra e prazo de emissão externo — por isso começa
primeiro, mesmo que os demais tickets não dependam dele.

## T2 — Levantar a Inscrição Municipal (IM)

- Tipo: HITL
- Bloqueado por: — (roda em paralelo com T1)
- Pronto quando: o número da IM está confirmado com a prefeitura.

Buscar no alvará de funcionamento, em nota fiscal anterior da empresa, ou no
site da prefeitura na área de Cadastro Mobiliário/ISS, pelo CNPJ. Sem a IM
correta, a SEFIN Nacional rejeita a emissão com o erro `E0116`.

## T3 — Confirmar regime tributário e anexo do Simples

- Tipo: HITL
- Bloqueado por: —
- Pronto quando: o contador confirmou por escrito o enquadramento (MEI, ME/EPP optante, não optante) e, se optante, o anexo do Simples Nacional do serviço prestado.

Essa informação define `NFSE_OP_SIMP_NAC`, `NFSE_REG_AP_TRIB_SN` e
`NFSE_P_TOT_TRIB_SN` no `.env`. Anexo errado produz um percentual errado de
tributos na nota (a "Lei da Transparência"), o que é um problema fiscal, não
só técnico.

## T4 — Confirmar os códigos do serviço (cTribNac e cNBS)

- Tipo: HITL
- Bloqueado por: —
- Pronto quando: o contador confirmou o item da Lista de Serviços da LC 116/2003 (`cTribNac`) e o código NBS (`cNBS`) de cada serviço que a operadora vende.

Código errado gera problema com a prefeitura e com a Receita. Se a operadora
vende mais de um tipo de serviço, cada tipo precisa do seu próprio par de
códigos confirmado.

## T5 — Rodar o assistente de configuração

- Tipo: AFK
- Bloqueado por: T1, T2, T3
- Pronto quando: existe um `.env` completo e `nfse check` executa sem erro de configuração ausente.

O assistente (`node setup.mjs`, ou `nfse setup` depois do `npm link`) pergunta
um item por vez, confere o CNPJ e resolve o código IBGE do município pelo
nome da cidade — por isso o código IBGE não tem ticket próprio. Este ticket
só pode rodar depois que T1, T2 e T3 tiverem resposta, porque o assistente
pede exatamente esses dados.

## T6 — Verificar a adesão do município ao Convênio NFS-e Nacional

- Tipo: AFK
- Bloqueado por: T5
- Pronto quando: `nfse check` responde que o município participa do Convênio NFS-e Nacional.

Se o município não participar, todo o caminho abaixo fica inviável e a
emissão precisa sair pelo sistema próprio da prefeitura, fora deste projeto.
Este é o ticket que pode invalidar o projeto inteiro — por isso vem antes de
qualquer tentativa de emissão, e não depois.

## T7 — Emitir a primeira nota em produção restrita

- Tipo: HITL
- Bloqueado por: T4, T6
- Pronto quando: uma nota é autorizada com `NFSE_AMBIENTE=2` e o XML aparece na pasta de autorização.

Serve para provar o caminho completo (assinatura, envio, retorno da SEFIN
Nacional) antes de qualquer nota valer como documento fiscal. Sem valor
fiscal — se algo falhar aqui, corrigir e repetir não tem custo.

## T8 — Emitir a primeira nota real

- Tipo: HITL
- Bloqueado por: T7
- Pronto quando: a nota é autorizada com `NFSE_AMBIENTE=1`, a chave de acesso é registrada e o DANFSe é baixado.

Irreversível: uma nota emitida em produção é um documento oficial, sem
"desfazer". Confira o tomador, o valor e a descrição do serviço antes de
rodar. Emita uma nota só (`--limite 1` ou `nfse emitir`), confira o resultado
com a operadora, e só então processe em volume maior.

## T9 — Configurar o envio por e-mail

- Tipo: AFK
- Bloqueado por: T8
- Pronto quando: um e-mail de teste chega com o DANFSe (PDF) em anexo.

Opcional: preencher `RESEND_API_KEY` e `RESEND_FROM_NOTAS` no `.env`. Sem
essas variáveis, a emissão continua funcionando normalmente, só que sem
enviar e-mail automático ao cliente.

## Fog

- **Volume de notas.** Ainda não dá para saber se o volume de vendas da
  operadora justifica automatizar a importação (por exemplo, agendar a
  importação da Lastlink em vez de rodar manualmente) — essa resposta só
  aparece depois de algumas semanas de operação real, depois de T8.
- **Correção de nota emitida com erro.** O procedimento para cancelar ou
  substituir uma nota (janela de prazo, se cancelamento simples resolve ou se
  exige substituição) depende das regras específicas do município da
  operadora, que ainda não são conhecidas antes de T2/T6. Essa pergunta não
  pode ser respondida com precisão hoje — só depois que o município estiver
  identificado e a adesão ao convênio confirmada.
- **Renovação do certificado.** O certificado A1 vence em um ano (T1); ainda
  não está decidido quem acompanha o vencimento e dispara a renovação a
  tempo, nem se isso deveria virar um lembrete automatizado.
