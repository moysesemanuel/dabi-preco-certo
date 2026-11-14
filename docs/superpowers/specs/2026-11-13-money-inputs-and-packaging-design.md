# Custô — campos monetários e embalagens

## Intenção

Facilitar a digitação de valores monetários sem transformar campos vazios em zeros e permitir contabilizar embalagens por produto e por encomenda, mantendo custos antigos estáveis e a sincronização local-first.

## Decisão de arquitetura

- Um componente React controlado (`MoneyInput`) manterá texto editável, aceitará decimal brasileiro/internacional e colagem de valores monetários, deixará o campo vazio quando vazio e formatará `pt-BR` no blur. O formulário continua responsável por validar valores obrigatórios/opcionais segundo suas regras existentes.
- Embalagens serão uma coleção versionada própria (`DataSet.packagings` / entidade D1 `packagings`), porque possuem preço de compra, quantidade de pacote, capacidade e estado ativo distintos de ingredientes. A coleção reutiliza IndexedDB, backups, versionamento, conflitos e protocolo de sync atuais.
- Receitas guardarão uma lista de referências `packagingItems` com quantidade consumida por unidade produzida; o custo unitário será calculado pelo preço do pacote dividido pela quantidade comprada, sem arredondamento intermediário. O campo legado `packagingPerUnit` continuará válido e será apresentado como outro custo manual de embalagem.
- Encomendas guardarão itens extras como snapshots (`packagingId`, nome, quantidade e custo unitário congelados). O snapshot financeiro preservará o custo base por unidade e o total de embalagens extras da encomenda; o custo exibido por unidade deriva desses valores e da quantidade atual, sem consultar preços atuais do catálogo.
- Capacidade serve somente como sugestão editável `ceil(quantidade do produto / capacidade)`. O usuário confirma a embalagem e pode mudar a quantidade; o sistema não presume adequação sem essa seleção explícita.
- Embalagens referenciadas por receitas podem ser desativadas, não excluídas. Sem referências podem ser removidas; snapshots de encomendas permanecem independentes do catálogo.
- Uma migração aditiva cria o catálogo, relação receita–embalagem e colunas de snapshot de encomenda. Ela não é aplicada remotamente nesta tarefa.

## Abordagens consideradas

1. **Reaproveitar ingredientes com um discriminante de tipo:** evitaria uma coleção nova, mas exporia embalagens às telas/conversões de ingredientes e permitiria clientes antigos mudarem sua classificação ao sincronizar. Rejeitada por semântica e compatibilidade.
2. **Embalar tudo em `Settings` ou JSON da receita:** reduziria tabelas, mas transformaria entidades independentes em um único conflito de configurações ou dificultaria integridade e isolamento referencial. Rejeitada.
3. **Coleção `packagings` versionada e relações/snapshots nos registros existentes:** preserva o padrão de entidade e conflitos já usado, com uma migração aditiva; escolhida.

## Escopo e limites

- Inclui cadastro, edição, capacidade opcional, associação de múltiplas embalagens à receita e adicionais na encomenda.
- Não inclui estoque, fornecedores, compras, lotes, novos contratos comerciais ou alterações remotas.
- Mantém fórmulas de margem, preços de venda, recebimentos e orçamentos públicos; adiciona somente custos de embalagem à composição de custo.
- Dados antigos sem coleção são lidos como `packagings: []`; encomendas antigas mantêm seus snapshots existentes e nenhum histórico é preenchido retroativamente.

## Segurança e integridade

- Validação estrita no cliente, backup e Worker para IDs únicos, preço não negativo em centavos, quantidade comprada positiva, capacidade positiva opcional, referências válidas, limites de payload e snapshots finitos.
- Consultas e alterações D1 permanecem sob `user_id`; exclusões são lógicas; relações de receita impedem a exclusão de embalagens em uso.
- Custos intermediários de embalagem mantêm precisão decimal até o total composto. Arredondamento visual ocorre no formato BRL; custo por unidade persistido aceita frações subcentavo.

## Critérios de aceite

- Campo monetário vazio exibe placeholder `R$ 0,00`, não contém valor zero e permanece vazio ao perder foco; valor existente é preservado e substituível, aceita colagem, e formata em `pt-BR`.
- Embalagens calculam custo unitário fracionário, podem ser associadas múltiplas vezes por receita e ser adicionadas a encomendas com quantidade sugerida editável.
- Custos por produto e extras por encomenda aparecem separados, entram uma única vez no custo e snapshots antigos continuam iguais após editar/remover o catálogo.
- Backup, IndexedDB e sync em SQLite local conservam relações e snapshots; conflitos e isolamento entre contas continuam protegidos.
- Migração é aditiva e ensaiada em SQLite; nenhuma operação remota é executada.
