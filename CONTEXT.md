# Glossário de Domínio — Emissor NFS-e

Este arquivo reúne o vocabulário do domínio da emissão de NFS-e (Nota Fiscal
de Serviço eletrônica) pelo padrão nacional brasileiro. Cada entrada define o
que o termo significa no domínio fiscal ou no vocabulário interno do projeto —
não como o código o implementa. Serve para um agente futuro não driftar para
sinônimos ao ler ou escrever código relacionado.

## Documentos e entidades fiscais

### DPS (Declaração de Prestação de Serviços)
Documento que o prestador declara para descrever um serviço prestado, contendo
dados do prestador, do tomador e da tributação aplicável. É a partir da DPS
que a SEFIN Nacional autoriza a NFS-e.

### NFS-e (Nota Fiscal de Serviço eletrônica)
Documento fiscal emitido pela SEFIN Nacional a partir de uma DPS autorizada;
representa oficialmente, perante o fisco, a prestação do serviço.

### DANFSe
Representação visual da NFS-e, destinada à leitura humana (o PDF entregue ao
tomador). Não é o documento fiscal em si — é sua representação; o documento
fiscal é a NFS-e.

### Chave de acesso
Identificador único atribuído a uma NFS-e no momento em que ela é autorizada;
permite localizar e consultar a nota depois. Diferente do nDPS: o nDPS é
escolhido pelo prestador antes da emissão como entrada do processo, enquanto a
chave de acesso é devolvida pelo sistema fiscal depois que a nota já existe.

### Prestador
Pessoa jurídica que presta o serviço e emite a nota.

### Tomador
Pessoa física ou jurídica que contrata e paga pelo serviço e para quem a nota
é emitida. Diferente do prestador: o prestador é fixo (quem emite), o tomador
varia a cada emissão (quem recebe).

### Competência (dCompet)
Mês, ou período, fiscal ao qual a prestação do serviço se refere — distinto da
data e hora em que o documento é efetivamente emitido.

### Série
Numeração que agrupa as notas emitidas por um mesmo prestador, compondo junto
com o nDPS a identificação sequencial da declaração.

### nDPS
Número sequencial atribuído pelo prestador a cada DPS antes de ela ser
enviada para autorização. Ver "Chave de acesso" para a distinção entre os
dois identificadores.

## Códigos

### cTribNac
Código do item de serviço conforme a lista de serviços da LC 116/2003;
identifica a natureza do serviço prestado para fins de tributação municipal
(ISSQN). Exemplo encontrado no projeto: `080201`, referente a instrução e
treinamento.

### cNBS (Nomenclatura Brasileira de Serviços)
Código complementar de classificação do serviço. Diferente do cTribNac: o
cTribNac classifica o serviço pela lista da LC 116/2003 para fins de ISSQN,
enquanto o cNBS é uma nomenclatura de serviços própria, usada em paralelo.

### cLocEmi
Código do município onde a nota é emitida — o local de emissão.

### cLocPrestacao
Código do município onde o serviço é efetivamente prestado — o local de
prestação. Pode coincidir com o cLocEmi, mas representa um conceito diferente:
onde a nota é emitida versus onde o serviço aconteceu.

### cIndOp
Código que indica a natureza da operação registrada na nota.

### cClassTrib
Código de classificação tributária aplicado à operação.

### Código IBGE do município
Identificador numérico oficial atribuído pelo IBGE a cada município
brasileiro; usado tanto para o local de emissão quanto para o local de
prestação do serviço.

### Inscrição Municipal (IM)
Número de cadastro do prestador junto à prefeitura do município onde está
estabelecido; identifica o contribuinte perante o fisco municipal.

### CNC (cadastro do contribuinte no município)
Cadastro do contribuinte mantido pela prefeitura do município do prestador.
Quando o prestador é o próprio emitente da nota, dados como nome e endereço
já constam nesse cadastro e por isso não precisam ser repetidos na DPS.

## Tributação

### opSimpNac
Indica a opção do prestador pelo Simples Nacional e sua situação: não
optante, MEI, ou ME/EPP.

### regApTribSN
Regime de apuração de tributos do Simples Nacional; aplica-se apenas quando o
prestador está enquadrado como ME/EPP.

### regEspTrib
Regime especial de tributação do prestador, para quando há algum regime
diferenciado além do enquadramento no Simples Nacional.

### pTotTribSN
Percentual aproximado de tributos do Simples Nacional incidentes sobre a
operação, conforme a Lei da Transparência — corresponde à alíquota inicial do
anexo do Simples em que o prestador está enquadrado.

### Lei da Transparência
Lei que exige a divulgação, no documento fiscal, do valor aproximado dos
tributos incidentes sobre a operação.

### Anexo do Simples Nacional
Cada anexo da tabela do Simples Nacional agrupa um conjunto de atividades com
sua própria tabela de alíquotas; determina o percentual usado no pTotTribSN.

### ISSQN
Imposto Sobre Serviços de Qualquer Natureza — o tributo municipal incidente
sobre a prestação de serviços que a NFS-e documenta.

### tpRetISSQN
Indica se o ISSQN da operação está sujeito a retenção na fonte pelo tomador.

## Infraestrutura fiscal

### SEFIN Nacional
Sistema nacional que recebe a DPS e realiza a autorização da NFS-e,
unificando o processamento que antes era feito por sistemas próprios de cada
município.

### ADN
Sistema nacional que centraliza dados das NFS-e emitidas dentro do padrão
nacional e disponibiliza sua consulta, complementando a SEFIN Nacional.

### Produção restrita
Ambiente de testes do padrão nacional que se comporta como produção, mas cujas
notas emitidas não têm validade fiscal real. Diferente da produção: mesmo
fluxo e mesma infraestrutura, sem efeito fiscal.

### mTLS
Autenticação mútua por certificado entre cliente e servidor, usada na
comunicação com os sistemas fiscais nacionais.

### Certificado A1 e-CNPJ
Certificado digital do tipo A1 (arquivo, sem necessidade de token físico),
emitido para o CNPJ do prestador; usado para assinar e autenticar as
comunicações com os sistemas fiscais.

### Autorização
Etapa em que a DPS enviada é validada e aceita pela SEFIN Nacional, resultando
na NFS-e oficialmente emitida e na atribuição da sua chave de acesso.

## Vocabulário interno do projeto

### Venda
Registro de uma venda de um produto ou serviço que pode dar origem a uma nota
fiscal; carrega os dados do cliente, o valor e o estágio de processamento em
direção à emissão.

### Nota
Registro de uma NFS-e já emitida, associado a uma venda; guarda a chave de
acesso e os arquivos gerados na emissão.

### Contrato
Cadastro de um cliente de fee mensal recorrente (dados do cliente, valor,
descrição do serviço e dia do mês de cobrança), guardado uma única vez.
Diferente de venda: o contrato não gera nota diretamente — ele é a origem a
partir da qual a geração mensal cria uma venda por competência, que então
segue o mesmo caminho de qualquer outra venda até virar nota.

### Geração mensal
Ato de criar, a partir dos contratos ativos, as vendas correspondentes à
competência do mês (uma venda por contrato). Idempotente: rodar a geração
mensal de novo para o mesmo mês não duplica vendas já criadas.

### Fila
Estágio de processamento em que uma venda se encontra a caminho da emissão
(por exemplo: pronta, pendente de cadastro, aguardando garantia, ou em
exceção). Diferente de status: a fila indica em que etapa do caminho a venda
está, o status indica o resultado desse processamento.

### Mapa de produtos
Correspondência entre um produto vendido e os campos fiscais que ele exige na
emissão (código de tributação, NBS, descrição do serviço).

### Emissão avulsa
Emissão de uma única NFS-e a partir de uma entrada isolada, fora do fluxo
normal de processamento da fila de vendas.

### Modo simulação
Modo de operação em que a DPS é montada e pode ser inspecionada, mas nenhuma
nota é de fato enviada para autorização.

### Modo real
Modo de operação em que a DPS é efetivamente enviada para autorização,
resultando em uma nota fiscal válida e irreversível. Diferente da produção
restrita: aqui a nota emitida tem validade fiscal real.

### Arquivar
Ação de organizar os arquivos de uma NFS-e já emitida (XML, PDF e dados
relacionados) em uma pasta própria, depois da emissão.
