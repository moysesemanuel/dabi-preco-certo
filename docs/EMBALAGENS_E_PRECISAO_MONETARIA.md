# Embalagens e edição monetária

## Decisão de modelo

Embalagens são uma coleção própria (`DataSet.packagings`, schema 4), versionada como uma entidade independente na sincronização. Ingredientes continuam representando itens consumidos em medidas culinárias; embalagem tem preço de compra, quantidade adquirida, capacidade opcional e estado ativo. Cada receita armazena zero ou mais relações `packagingItems` com quantidade por unidade produzida. O campo legado `Recipe.packagingPerUnit` permanece aceito como custo manual por unidade, sem ser reinterpretado nem migrado.

Uma encomenda guarda duas listas com finalidades diferentes: `costSnapshot.packagingItems` congela nome, custo unitário e consumo das embalagens incluídas automaticamente pela receita; `Order.packagingItems` congela embalagens extras escolhidas para aquela encomenda. A segunda lista é a fonte de verdade dos custos adicionais; seu total é derivado de `quantidade × custoUnitário`. Alterar receita ou catálogo não recalcula os snapshots existentes. Alterar apenas a quantidade da encomenda conserva custo por unidade e extras já selecionados. Trocar receita captura o custo do novo produto, preservando extras explicitamente associados ao pedido.

Custos unitários podem ter mais de duas casas decimais (por exemplo, R$ 0,01 / 200 = R$ 0,00005). A divisão fica sem arredondamento no catálogo, nas relações da receita e nos snapshots. O custo unitário exibido em receita é arredondado para centavos; valores unitários do catálogo podem exibir até oito casas. Totais e valores comerciais continuam arredondados pelas funções financeiras existentes no ponto de apresentação/gravação.

## Exclusão e compatibilidade

Embalagem usada por receita ou encomenda é desativada, não removida: referências e fatos históricos continuam legíveis. A desativação impede novas associações; receitas já vinculadas permanecem válidas e continuam usando o custo congelado na encomenda. Exclusão física só é permitida quando não houver dependências.

Backups dos schemas 1–3 são aceitos e recebem `packagings: []`; registros antigos não ganham custo inventado. A migração `worker/migrations/0010_packagings.sql` cria catálogo e relações e adiciona colunas JSON opcionais a encomendas. Ela não atualiza snapshots existentes. O Worker normaliza pushes antigos sem a categoria `packagings`; quando uma receita enviada por cliente antigo omite `packagingItems`, a relação existente é preservada. Lista vazia explícita de cliente novo remove os vínculos.

## Migração e publicação futura

1. Fazer backup remoto verificável, fora deste passo local.
2. Conferir que o banco correto é staging e que `0001`–`0009` estão aplicadas.
3. Aplicar somente `0010_packagings.sql` em staging com o comando Wrangler aprovado para esse binding; confirmar `packagings`, `recipe_packaging_items`, `orders.packaging_items_json` e `orders.cost_snapshot_packaging_json` local/remotamente por leitura.
4. Publicar o Worker compatível com a migration antes do frontend.
5. Confirmar pull/push e isolamento da conta no staging; só depois publicar o Pages desta revisão.
6. Homologar backup/exportação/importação, receita com duas embalagens, extras da encomenda, quantidade sugerida/manual, recebimentos, sync offline/reconexão e dispositivos.

Rollback do código não desfaz migration nem dados. Não remover tabelas/colunas depois de receber escritas. Primeiro interromper a publicação de novas páginas, preservar backup e revisar o erro. Não reverter apenas o Worker para uma versão que não compreende a categoria `packagings` depois que o frontend novo tiver sincronizado esse tipo. Reverter app e Worker conjuntamente para uma revisão compatível somente se a revisão antiga puder manter os dados novos; caso contrário restaurar o frontend novo e reverter apenas uma correção compatível. Nunca apagar dados para “desmigrar”.

## Campos monetários

`MoneyInput` mantém rascunho textual durante digitação, usa teclado decimal no celular, aceita colagem brasileira ou internacional, diferencia vazio de zero e apenas apresenta a formatação pt-BR quando desfocado. Ingrediente, preço, sinal e recebimento são obrigatórios na validação correspondente. Taxa e desconto do orçamento são opcionais; custos manuais opcionais da receita em branco significam ausência explícita de custo (R$ 0,00), explicado junto aos campos. Embalagens usam preço de compra obrigatório. Nenhum endpoint de autenticação foi alterado.

## Evidência local

A migration é aplicada em SQLite efêmero em `tests/packaging.test.ts` e no ensaio `tests/ops/migration-rehearsal.test.ts`. A sincronização percorre o Worker real com D1 simulado por SQLite em `tests/sync-server.test.ts`, incluindo referência cruzada entre usuários e atualização antiga sem `packagingItems`. Esses testes não alteram Cloudflare/D1 remoto. Login real, PWA/mobile, publicação e migração remota continuam a exigir homologação autorizada.
