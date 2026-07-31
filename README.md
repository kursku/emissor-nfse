# Emissor de NFS-e

Emissor de Nota Fiscal de Serviço eletrônica (NFS-e) pelo padrão nacional
brasileiro — o Convênio NFS-e Nacional, operado pela SEFIN Nacional
(`sefin.nfse.gov.br`) e pelo ADN (Ambiente de Dados Nacional,
`adn.nfse.gov.br`) — com CLI, fila de processamento, painel web, arquivamento
de notas e envio por e-mail.

> **Aviso**
> Emitir uma nota fiscal em produção gera um **documento oficial e
> irreversível** — não existe "desfazer", só cancelamento ou substituição,
> dentro do prazo que a prefeitura do município permitir. Este software
> **não substitui um contador**: os códigos fiscais do serviço (item da Lista
> de Serviços da LC 116/2003 e código NBS), o regime tributário e, quando
> aplicável, o anexo do Simples Nacional são responsabilidade de quem opera o
> sistema e **devem ser confirmados com um contador** antes da primeira
> emissão real. O software é fornecido **sem garantia de qualquer tipo**.

## Status

- Em desenvolvimento, e já emitiu NFS-e autorizada em produção: DPS assinada
  com certificado A1, aceita pela SEFIN Nacional, com XML e DANFSe
  arquivados. O caminho completo está descrito em `tickets.md`.
- Testes e verificação de tipos rodam em Windows e Linux no CI. A **emissão
  com certificado** só foi exercitada em Windows: o contorno de OpenSSL
  legado (o `.p12` usa cifra antiga) aponta para o OpenSSL do Git for
  Windows. Em Linux/macOS pode ser preciso habilitar o provider legacy.
- Usa `node:sqlite`, módulo nativo do Node ainda marcado como
  **experimental**, e por isso o projeto exige **Node 24 ou superior**.
- Uma limitação conhecida vale destaque: quando o ISS incide no domicílio do
  tomador, a SEFIN recusa a nota sem o endereço completo do cliente (erro
  E0234). Se a sua origem de vendas não coleta endereço, parte das notas não
  será emitível. A importação separa esses casos numa fila própria
  (`pronta_sem_endereco`) em vez de deixá-los falhar no envio.

## O que faz / o que não faz

**Faz**, em resumo: monta e envia a DPS para a SEFIN Nacional, processa em
lote uma fila de vendas, emite notas avulsas, guarda histórico num banco
SQLite local, envia a nota por e-mail e mostra um painel web para
acompanhamento. A descrição completa está na seção 1 abaixo.

**Não faz:** não substitui o contador (não calcula impostos nem apuração do
Simples Nacional), não funciona em municípios que não aderiram ao Convênio
NFS-e Nacional, e não desfaz uma nota já emitida em produção.

## Requisitos

- **Node.js 24 ou superior** (`node:sqlite` é experimental e exige essa
  versão).
- Certificado digital **A1 e-CNPJ**, em arquivo `.p12` ou `.pfx` (certificado
  A3, em token ou cartão, não serve para esta automação).
- Município do prestador aderido ao **Convênio NFS-e Nacional**.
- **Inscrição Municipal (IM)** do prestador, ativa na prefeitura.

## Quick start

```
npm install
nfse setup
nfse check
nfse fila --limite 5
```

Nenhum dos quatro comandos acima emite nota real: `nfse fila` roda em modo
simulação por padrão. Emitir de verdade exige definir `NFSE_AMBIENTE=1` no
`.env` **e** passar a flag `--real` — veja a seção 4 antes de fazer isso.

## Comandos

| Comando | Uso | O que faz |
|---|---|---|
| `setup` | `nfse setup` | assistente de configuração — cria o `.env` passo a passo |
| `check` | `nfse check [cTribNac]` | verifica adesão do município ao Convênio Nacional e a alíquota vigente |
| `painel` | `nfse painel` | abre o painel web em `http://localhost:3000` |
| `fila` | `nfse fila [--limite N] [--real]` | processa a fila de vendas (simulação por padrão; `--real` emite de verdade) |
| `emitir` | `nfse emitir <nota.json> --real` | emite uma nota avulsa a partir de um JSON (ver `nota-exemplo.json`) |
| `importar` | `nfse importar <planilha.xlsx>` | importa o relatório `sales_list` da Lastlink para o banco |
| `contratos` | `nfse contratos <criar\|listar\|desativar\|gerar>` | contratos recorrentes: cadastra uma vez, gera as vendas do mês |
| `arquivar` | `nfse arquivar <id_venda>` | salva XML e DANFSe da nota em `output/notas/<AAAA-MM>/<id_venda>/` |

Rode `nfse --help` para ver esta mesma lista a qualquer momento.

## Núcleo e integrações

O núcleo do projeto é a emissão de NFS-e em si: CLI, configuração, fila de
processamento, painel web, banco de dados local, arquivamento de notas e
envio por e-mail. Esse núcleo não depende de nenhuma origem de vendas
específica.

`importar` (relatório de vendas da Lastlink) e `contratos` (clientes de fee
mensal recorrente) são **integrações opcionais**, isoladas em
`integracoes/`. Elas servem como exemplo de como plugar uma origem de vendas
ao núcleo — quem usa outra plataforma pode escrever um importador
equivalente sem tocar na emissão em si.

## Saiba mais

- Glossário de domínio (termos fiscais e vocabulário interno): `CONTEXT.md`
- Decisões de arquitetura registradas: `docs/adr/`
- Como contribuir, rodar testes e propor mudança em código fiscal:
  `CONTRIBUTING.md`

---

A partir daqui, o README segue como um guia operacional passo a passo, para
quem for operar o sistema no dia a dia sem precisar entender o código por
trás.

## 1. O que o sistema faz e o que ele não faz

**Faz:**

- Monta e envia a DPS (Declaração de Prestação de Serviços) para a SEFIN
  Nacional e recebe de volta a NFS-e autorizada (XML + PDF/DANFSe).
- Processa em lote uma lista de vendas (por exemplo, importada da Lastlink)
  e emite uma nota para cada uma.
- Emite uma nota avulsa a partir de um arquivo com os dados do cliente e do
  serviço.
- Guarda um histórico das notas emitidas num banco de dados local (SQLite).
- Envia a nota por e-mail para o cliente, em anexo, quando configurado.
- Mostra um painel web simples para acompanhar as notas emitidas.

**Não faz:**

- Não substitui o contador. Ele não calcula impostos, não faz a apuração do
  Simples Nacional e não entrega obrigações acessórias (DAS, DEFIS, etc.).
- Não funciona em municípios que ainda não aderiram ao Convênio NFS-e
  Nacional (veja a seção 2.4).
- Não desfaz uma nota emitida em produção. Uma nota fiscal emitida é um
  documento oficial — só é possível corrigir por meio de cancelamento ou
  substituição, dentro do prazo que a prefeitura permitir (veja a seção 4).

## 2. Pré-requisitos

Antes de usar o sistema, você precisa ter em mãos as informações abaixo.

### 2.1 Certificado digital A1 e-CNPJ

O sistema assina os documentos fiscais digitalmente e por isso precisa de um
**certificado digital A1**, no formato de arquivo `.p12` ou `.pfx`.

- O certificado A1 é comprado numa Autoridade Certificadora credenciada pela
  ICP-Brasil (Serasa, Certisign, Valid, entre outras). Tem validade de 1 ano
  e depois precisa ser renovado.
- **Importante:** o certificado precisa ser do tipo **A1** (arquivo). O
  certificado **A3** (aquele que vem num cartão ou token USB) **não serve**
  para esta automação, porque a chave privada fica presa dentro do
  dispositivo físico e não pode ser usada por um programa rodando sem
  interação humana constante.
- Ao comprar, peça explicitamente o "e-CNPJ A1, arquivo .p12".

### 2.2 Inscrição Municipal (IM)

É o número de cadastro da empresa na prefeitura (também chamado de CCM —
Cadastro de Contribuintes Mobiliários, dependendo do município).

Onde encontrar:

- No alvará de funcionamento da empresa.
- Em qualquer nota fiscal de serviço emitida anteriormente pela empresa.
- No site da prefeitura, na área de "Cadastro Mobiliário" ou "ISS", buscando
  pelo CNPJ.

### 2.3 Código IBGE do município

É um número de 7 dígitos que identifica o município do prestador de
serviço perante o IBGE.

Onde encontrar:

- `https://www.ibge.gov.br/explica/codigos-dos-municipios.php`
- Ou pela API pública: `https://servicodados.ibge.gov.br/api/v1/localidades/municipios`

### 2.4 Adesão do município ao Convênio NFS-e Nacional

Nem toda prefeitura aderiu ao padrão nacional ainda. Antes de tentar emitir,
rode:

```
nfse check
```

Esse comando consulta se o seu município participa do Convênio NFS-e
Nacional e, se participar, também mostra a alíquota de ISS cadastrada para
consulta.

- **Se o município aderiu:** você pode seguir usando este sistema.
- **Se o município não aderiu:** a emissão pela SEFIN Nacional não vai
  funcionar. Nesse caso você precisa emitir pelo sistema próprio da
  prefeitura (fora deste projeto) até que ela adira ao convênio nacional.

### 2.5 Regime tributário e anexo do Simples Nacional

Você precisa saber, com certeza, qual é o enquadramento tributário da
empresa:

- **MEI** (Microempreendedor Individual)
- **ME/EPP optante pelo Simples Nacional**
- **Não optante pelo Simples Nacional**

E, se for ME/EPP optante pelo Simples, qual é o **anexo** do Simples
Nacional em que o serviço prestado se enquadra (isso define o percentual
usado na "Lei da Transparência", por exemplo Anexo III = alíquota inicial de
6,00%, Anexo V = 15,50%). **Confirme esse dado com o seu contador** — usar o
anexo errado pode gerar problemas fiscais.

### 2.6 Códigos do serviço prestado

Toda nota precisa de dois códigos que identificam o tipo de serviço:

- **`cTribNac`** — o item da Lista de Serviços da Lei Complementar 116/2003,
  com 6 dígitos. Exemplos: `080201` (instrução, treinamento, orientação
  pedagógica), `010601` (consultoria em informática).
- **`cNBS`** — o código da Nomenclatura Brasileira de Serviços (NBS), com 9
  dígitos.

**Confirme os dois códigos com o seu contador** antes da primeira emissão —
eles dependem exatamente do serviço que a empresa presta e usar o código
errado pode gerar problema com a prefeitura ou com a Receita.

## 3. Instalação

1. Instale o Node.js versão 20.12 ou mais recente.
2. Na pasta do projeto, instale as dependências:

   ```
   npm install
   ```

3. Rode o assistente de configuração. Ele pergunta um item por vez, confere o
   CNPJ, encontra o código IBGE da sua cidade pelo nome e escreve o `.env`
   para você:

   ```
   node setup.mjs
   ```

   (Depois do passo 5 abaixo, o mesmo assistente atende por `nfse setup`.)

   A senha do certificado não aparece na tela enquanto é digitada. Se já
   existir um `.env`, o assistente pergunta antes de sobrescrever.

4. Prefere preencher na mão? Copie o modelo e edite num editor de texto:

   ```
   cp .env.example .env
   ```

   (No Windows/PowerShell: `Copy-Item .env.example .env`)

   Cada variável está comentada no arquivo. Não deixe nenhum campo
   obrigatório em branco.

5. (Opcional) Deixe o comando `nfse` disponível em qualquer pasta do
   computador:

   ```
   npm link
   ```

   Sem esse passo, use `node cli.mjs <comando>` de dentro da pasta do
   projeto — é exatamente a mesma coisa. Rode `nfse --help` para ver todos os
   comandos.

## 4. Primeira emissão — vá com cautela

Uma nota fiscal emitida **em produção é um documento oficial e irreversível**.
Não existe "desfazer". A única forma de corrigir um erro é cancelar ou
substituir a nota, dentro do prazo que a prefeitura do seu município permitir
(alguns municípios dão poucos dias para isso).

Por isso, antes de emitir a primeira nota real:

1. **Teste em modo simulação primeiro.** A fila roda em modo de simulação por
   padrão — ela mostra o que seria enviado, mas não emite nada de verdade:

   ```
   nfse fila --limite 5
   ```

2. **O padrão do sistema é produção restrita, não produção real.** Se a
   variável `NFSE_AMBIENTE` não estiver definida no `.env`, o sistema assume
   `NFSE_AMBIENTE=2` (produção restrita/homologação — mesmo fluxo da SEFIN
   Nacional, mas a nota emitida não tem validade fiscal). **Emitir de
   verdade exige definir `NFSE_AMBIENTE=1` explicitamente** no `.env`. Só
   faça essa mudança quando tiver certeza de que os dados cadastrais (IM,
   código do serviço, regime tributário) estão corretos — errar o valor de
   uma variável custa pouco, uma nota emitida em produção real é
   irreversível.

3. Só depois de validar em simulação/homologação, emita uma nota real com
   a flag `--real`.

## 5. Uso no dia a dia

### Painel web

Abre uma tela no navegador para acompanhar as notas emitidas:

```
nfse painel
```

Depois acesse `http://localhost:3000` no navegador.

### Simular a fila (não emite nada de verdade)

```
nfse fila --limite 5
```

### Emitir de verdade em lote

```
nfse fila --limite 1 --real
```

A flag `--real` funciona igual no PowerShell, no Prompt de Comando e no
terminal do Mac/Linux.

Recomenda-se começar com `--limite 1` para conferir a primeira nota real
antes de rodar em volume maior.

### Emitir uma nota avulsa

Para emitir uma única nota a partir de um arquivo JSON com os dados do
cliente e do serviço:

```
nfse emitir nota.json --real
```

### Arquivar uma nota já emitida

Guarda o XML e o PDF da nota numa pasta de arquivamento:

```
nfse arquivar <id_venda>
```

### Importar vendas da Lastlink

O sistema consegue importar o relatório de vendas exportado da Lastlink
(arquivo `sales_list` em `.xlsx`) para alimentar a fila de emissão.

### Contratos recorrentes (clientes de fee mensal)

Para clientes que pagam uma mensalidade fixa (fee recorrente), em vez de
importar uma venda por mês manualmente, cadastre o contrato uma única vez.
Todo mês, gere as vendas correspondentes a partir dos contratos ativos — as
vendas geradas seguem depois pelo fluxo normal da fila (`nfse fila`).

Cadastrar um novo contrato:

```
nfse contratos criar --doc <CPF/CNPJ> --nome <nome do cliente> \
  --valor <valor mensal> --desc <descrição do serviço> --ctrib <cTribNac> \
  [--email <e-mail>] [--cnbs <cNBS>] [--dia <dia do mês, 1-31>]
```

- `--doc`, `--nome`, `--valor`, `--desc` e `--ctrib` são obrigatórios.
- `--email` e `--cnbs` são opcionais.
- `--dia` é o dia do mês em que a venda deve ser gerada (padrão: 1). Se o
  mês não tiver esse dia (ex.: dia 31 em fevereiro), o sistema usa o último
  dia do mês.

Listar contratos cadastrados:

```
nfse contratos listar
```

Por padrão mostra só os contratos ativos. Use `nfse contratos listar --todos`
para incluir os desativados.

Desativar um contrato (soft-delete — não gera mais vendas novas, mas não
apaga o histórico):

```
nfse contratos desativar <id>
```

Gerar as vendas do mês para todos os contratos ativos:

```
nfse contratos gerar [AAAA-MM]
```

Sem argumento, gera para o mês corrente. A operação é idempotente: rodar de
novo para a mesma competência não duplica vendas já geradas.

### Envio por e-mail

O envio de e-mail com o DANFSe (o PDF da nota) só acontece no processamento
em lote da fila, quando rodado com `--real`:

```
nfse fila --limite 1 --real
```

Se as variáveis `RESEND_API_KEY` e `RESEND_FROM_NOTAS` estiverem preenchidas
no `.env`, cada nota emitida de verdade por esse comando é enviada por
e-mail para o cliente automaticamente. Sem essas variáveis, a fila continua
emitindo normalmente — só não manda e-mail.

**Nenhum outro caminho de emissão envia e-mail hoje:**

- `nfse emitir nota.json --real` (nota avulsa) emite a nota, mas não envia
  e-mail.
- Emitir pelo painel web (`nfse painel`) também não envia e-mail.

Se precisar mandar o DANFSe de uma nota emitida por esses dois caminhos,
envie manualmente.

## 6. Solução de problemas

- **Certificado vencido:** certificados A1 valem 1 ano. Se a emissão falhar
  com erro relacionado a certificado/assinatura, confira a validade do
  `.p12` e renove com a Autoridade Certificadora se necessário.

- **Senha errada do `.p12`:** confira se `NFSE_CERT_PASSWORD` no `.env` é
  exatamente a senha definida quando o certificado foi exportado/comprado.

- **Erro de OpenSSL "legacy" no Windows:** o arquivo `.p12` normalmente usa
  uma cifra mais antiga que o OpenSSL moderno não habilita por padrão. O
  código já aponta a variável `OPENSSL_MODULES` para o OpenSSL que vem junto
  do Git for Windows (`C:/Program Files/Git/mingw64`), então isso já deve
  funcionar sem configuração extra no Windows. Em Linux/macOS, pode ser
  necessário habilitar o "legacy provider" do OpenSSL manualmente.

- **Erro `E0116`:** Inscrição Municipal ausente ou inválida. Confira se a IM
  configurada em `NFSE_IM` está correta e ativa no cadastro da prefeitura.

- **Erro `E0166`:** falta informar o regime de apuração do Simples Nacional
  (`NFSE_REG_AP_TRIB_SN`) quando a empresa é optante ME/EPP. Preencha essa
  variável no `.env`.

- **Erro `E0712`:** o campo `indTotTrib` está proibido para empresas ME/EPP
  optantes pelo Simples — nesse caso a informação correta é o percentual
  aproximado de tributos (`NFSE_P_TOT_TRIB_SN`), não o indicador de "total de
  tributos". Confira se `NFSE_P_TOT_TRIB_SN` está preenchido corretamente.

- **Falha de TLS/conexão com a SEFIN Nacional:** normalmente é um problema na
  cadeia de certificados (CAs) reconhecida pelo sistema. O projeto já inclui
  um `ca_bundle.crt` para resolver isso — confira se o arquivo está presente
  na pasta do projeto.

Se um erro não estiver listado aqui, anote o código do erro e a mensagem
completa e consulte o seu contador ou quem configurou o sistema.

## 7. Segurança e privacidade

- O certificado digital (`.p12`) e o arquivo `.env` **nunca** devem ser
  enviados para o git/GitHub — eles já estão listados no `.gitignore` do
  projeto. Não remova essa proteção.
- O banco de dados local `output/emissor.db` guarda CPF/CNPJ, nomes e
  e-mails de clientes. Isso é **dado pessoal protegido pela LGPD**. Não
  compartilhe esse arquivo, não envie por e-mail e não versione no git.
- Trate a senha do certificado (`NFSE_CERT_PASSWORD`) e a chave do Resend
  (`RESEND_API_KEY`) como senhas normais: não compartilhe, não cole em
  chats ou documentos abertos.
