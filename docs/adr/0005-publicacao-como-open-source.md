# 0005 — Publicação como open source

- Status: aceita
- Data: 2026-07-30

## Contexto e problema

O projeto nasceu como fork higienizado de um repositório privado de uso de
uma única pessoa: o repositório de origem tinha CNPJ, Inscrição Municipal,
caminho e senha de certificado, e dados de clientes hardcoded no código-fonte
(ADR-0001, ADR-0003), o que impedia qualquer publicação. Esse trabalho de
higienização — mover identidade fiscal e dados de terceiros para fora do
código-fonte, para variáveis de ambiente e arquivos de entrada — já foi
feito.

O nicho de emissão de NFS-e pelo padrão nacional (Convênio NFS-e Nacional)
tem pouca oferta de implementação aberta em Node.js/TypeScript, e a
documentação deste projeto é toda em português — uma vantagem real para o
público brasileiro, que é quem mais precisa emitir por esse padrão. Havia
motivo para publicar, mas também um risco concreto: o sistema, até este ADR,
nunca emitiu uma nota fiscal real através deste repositório — só em produção
restrita (ambiente de homologação, sem valor fiscal). Publicar um emissor
fiscal que nunca foi exercitado ponta a ponta em produção real significa
publicar código cujo comportamento sob condições reais ainda não foi
observado.

## Decisão

Publicar o projeto como open source, sob licença MIT, mas **só depois que o
sistema emitir a primeira nota fiscal real** (ver `tickets.md`, ticket T8).
Até lá, o repositório permanece privado. A licença MIT e o aviso de ausência
de garantia, presentes no topo do README, cobrem o uso por terceiros depois
da publicação.

Adotar também o posicionamento **núcleo + integrações opcionais**: o núcleo
publicado (emissão, configuração, CLI, fila, painel, banco, arquivamento,
e-mail) não depende de nenhuma origem de vendas específica; as integrações
com a Lastlink e com contratos recorrentes de fee mensal continuam no
repositório, isoladas em `integracoes/`, como exemplo de como plugar outra
origem de vendas ao núcleo — não como parte obrigatória do sistema.

## Consequências

### Positivas

- Preenche uma lacuna real: pouca oferta de emissor de NFS-e nacional aberto
  em Node/TypeScript, com documentação em português.
- Esperar a primeira emissão real antes de publicar significa que o código
  publicado já foi exercitado ponta a ponta pelo menos uma vez, não apenas
  em produção restrita.
- O posicionamento núcleo + integrações deixa claro, para quem for adaptar o
  projeto a outra origem de vendas, o que é essencial e o que é exemplo.

### Negativas / custo aceito

- Responsabilidade sobre uso indevido ou mal interpretado do sistema por
  terceiros — mitigada pelo aviso de ausência de garantia no README e pelos
  termos da licença MIT, mas não eliminada por completo.
- Superfície de suporte maior depois da publicação: issues e dúvidas de
  pessoas que não são a operadora original, sobre um domínio (fiscal) onde
  erro tem consequência legal.
- Publicar depois da primeira emissão real adia a publicação por um tempo
  indeterminado, dependente de tickets que envolvem terceiros (certificado,
  confirmação de contador) fora do controle do projeto.

## Alternativas rejeitadas

### Manter privado, por usuário — rejeitada

Congelaria correções e melhorias para o uso de uma única pessoa, sem
benefício para quem mais precisa de um emissor de NFS-e nacional aberto em
português. Não resolve o problema de escassez de oferta no nicho.

### Publicar imediatamente, como alpha — rejeitada

Exporia um emissor fiscal ainda não exercitado ponta a ponta em produção
real para uso de terceiros, sob um domínio onde erro de emissão é
irreversível e tem consequência legal. O risco de alguém emitir uma nota
real com base em código não validado supera o ganho de publicar mais cedo.
