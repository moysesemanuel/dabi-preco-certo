# Etapa 11: pedidos com várias receitas e confirmação automática por pagamento

Implementação **local** (14/11/2026). Nada foi publicado: sem deploy, sem push, sem migração remota e sem alteração de segredos, DNS ou `worker/wrangler.toml`.

## 1. Diagnóstico do modelo anterior

- A `Order` tinha uma receita só: `recipeId`, `quantity`, `unitPrice` e `costSnapshot` no próprio pedido. Um cliente com três produtos exigia três encomendas.
- No D1, as mesmas informações ficavam em colunas de `orders` (`recipe_id`, `quantity`, `unit_price`, `cost_per_unit`, `cost_captured_at`, `cost_snapshot_packaging_json`).
- O status era mudado só manualmente. Registrar um sinal ou um recebimento num orçamento não o confirmava.
- **Defeito encontrado:** na validação de um envio, o servidor só conhecia as embalagens citadas nas receitas e nas embalagens adicionais. Não conhecia as citadas no custo congelado da receita, então editar depois uma encomenda cuja receita tinha embalagens era recusado ("snapshot de embalagem da receita inválido"). Foi corrigido em `worker/src/sync.ts`, com teste.

## 2. Novo modelo

```ts
type OrderItem = { id; recipeId; recipeName?; quantity; unitPrice; costSnapshot? };
type Order = { id; customer; items: OrderItem[]; deliveryDate; status; deposit; createdAt;
               packagingItems?; packagingCharge?; quoteCode?; payments? };
```

**Na encomenda** ficam o cliente, o código ORC, a entrega, o status, as embalagens adicionais (`packagingItems`/`packagingCharge`), os recebimentos, o saldo e os links.

**Cada item** tem `id` próprio, a receita, o nome da receita congelado, a quantidade, o preço unitário e o custo congelado da receita. Esse custo já inclui as embalagens da **própria** receita (`costSnapshot.packagingItems`).

**O subtotal não é gravado.** É sempre `quantidade × preço` em centavos (`itemSubtotal`), para nunca divergir do total.

**Limite:** de 1 a 50 itens por encomenda.

**Receita repetida (regra adotada):** a mesma receita não pode aparecer em dois itens da mesma encomenda. O formulário não oferece a receita já escolhida, e o domínio recusa com "some as quantidades em um único item". Isso impede a duplicidade acidental. Diferenças legítimas, como o mesmo produto a preços diferentes, ficam para uma evolução futura, se necessário.

## 3. Cálculo (domínio: `src/domain/orderFinancials.ts`)

```
subtotalProdutos  = Σ (quantidade × preço unitário)   (cada subtotal arredondado a centavos)
totalEmbalagens   = Σ (quantidade × custo unitário registrado)   → congelado em packagingCharge
totalCobrado      = subtotalProdutos + packagingCharge
custoEstimado     = Σ (custo unitário do item × quantidade) + custo das embalagens adicionais
```

- **Exemplo obrigatório:** 50 × 2,50 + 30 × 2,50 + 1 × 65,00 = **265,00**. Com 12,00 de embalagens, o total é **277,00** (testado).
- **Custo indisponível:** se algum item não tem custo calculável, o custo da encomenda fica "Indisponível". Nunca é tratado como zero.
- **Capacidade das embalagens:** só sugere quantidade quando a encomenda tem **um** produto. Com vários produtos, a quantidade da embalagem é manual, porque não se presume que uma caixa comporta produtos diferentes misturados.

**Histórico:** ao criar um item, o custo atual e o nome da receita são congelados. Ao editar:
- um item que mantém a receita **conserva** custo e nome; só mudam a quantidade e o preço, alterados pelo usuário;
- um item novo, ou que trocou de receita, recebe o custo atual;
- nada é recalculado em silêncio.

## 4. Confirmação automática por pagamento (`src/domain/orderStatus.ts`)

Regra: um **Orçamento** que recebe um valor **efetivamente registrado** e maior que zero passa a **Confirmado**. Isso vale para:
- o sinal informado na criação;
- o aumento do sinal na edição;
- um novo recebimento;
- os recebimentos somados numa reconciliação;
- os recebimentos da nuvem mantidos ao escolher "manter minha versão".

| Situação | Resultado |
|---|---|
| Orçamento sem sinal | Continua Orçamento |
| Orçamento com sinal ou com pagamento parcial/integral | Confirmado |
| Valor zero, inválido, acima do saldo ou falha | Nada muda (a operação é recusada inteira) |
| Confirmado, Em produção ou Entregue recebendo pagamento | Status mantido |
| Remover ou corrigir um recebimento | Status mantido (não volta a Orçamento) |
| Carregar ou migrar dados antigos | Status mantido (nada retroativo) |

**Consistência entre pagamento e status:** os dois estão no **mesmo registro** (`Order`). Por isso são gravados juntos, numa única gravação no IndexedDB e numa única transação no D1. Não existe estado intermediário persistente.

**Repetições:** um recebimento repetido (mesmo `id`) é recusado. Um reenvio idêntico ao servidor é tratado como "sem alteração".

Confirmado nunca avança sozinho para Em produção. Voltar a Orçamento só é possível por escolha explícita no campo de status.

## 5. Telas

- **Nova encomenda:** lista de produtos, cada um com receita, quantidade, preço, subtotal e botão de remover. O botão **"+ Adicionar receita"** inclui outro produto.
  - O resumo financeiro aparece antes do sinal e é atualizado em tempo real.
  - O sinal é opcional. Quando informado, aparece o aviso "Ao registrar este sinal, a encomenda será confirmada automaticamente."
- **Pedidos (`/pedidos`):** o resumo mostra "3 itens — Brigadeiro Gourmet, Beijinho e Bolo de cenoura". Com mais de três itens, aparece "e mais N". A busca encontra o pedido por **qualquer** receita.
- **Detalhes (`/pedidos/:id`):** tabela por item (produto, quantidade, preço, subtotal e custo unitário, marcado "(estimado)" quando não houver registro). Também mostra as embalagens de cada receita e as adicionais.
  - Ao registrar o primeiro recebimento de um orçamento, a tela avisa que ele será confirmado.

## 6. Orçamento público (link `/o/*`, JSON, prévia e texto do WhatsApp)

A apresentação segue uma regra única, em `publicLines` (`src/features/sharing/quotes.ts`):

- **Sem embalagens adicionais cobradas:** cada produto aparece com quantidade, preço unitário e subtotal. A soma é exatamente o total.
- **Com embalagens adicionais:** os produtos aparecem **sem preço próprio** (campo opcional `includedItems` do contrato público), e o valor aparece numa linha consolidada, "Valor da encomenda".
  - O cliente nunca vê o valor, o nome ou a quantidade das embalagens.
  - Nenhuma soma visível diverge do total: não há rateio nem arredondamento inventado.
- Se o cálculo público em inteiros não reproduzir exatamente o subtotal (quantidades fracionárias), também se usa a forma consolidada.
- Entrega e desconto continuam funcionando.
- **Orçamentos já publicados** não são regenerados nem recalculados. O contrato continua `version: 1`, com o campo opcional acrescentado. Links antigos, revogação, expiração e a ocultação da linha antiga "Embalagens adicionais" (commit `bf8789c`) continuam valendo.

## 7. Compatibilidade com encomendas antigas

- **Conversão determinística (`upgradeOrderShape`):** a encomenda de uma receita vira **um item** com id fixo `item-1`, o mesmo custo histórico (ou nenhum) e **sem** nome registrado. O app mostra o nome atual da receita, sem inventar histórico.
  - Status, sinal, recebimentos, código e totais não mudam.
- **Onde a conversão é aplicada:**
  - ao ler o IndexedDB (`migrateStored`);
  - nos metadados de sincronização: a base e os conflitos pendentes (`migrateMeta`);
  - nos backups v1–v4 (`validateDataSet`);
  - no Worker, ao ler uma encomenda sem linhas em `order_items`.
- **Sem conflitos falsos:** dois aparelhos e o servidor chegam ao mesmo resultado.
- **Versão do esquema:** os dados passam a ser `schemaVersion: 5`, e backups v1–v4 continuam aceitos.

## 8. Migração D1 `0012_order_items.sql`

- **Tabela nova `order_items`:** chave `(user_id, order_id, position)`, colunas `id`, `recipe_id`, `recipe_name`, `quantity`, `unit_price`, `cost_per_unit`, `cost_captured_at` e `cost_packaging_json`. Índice `(user_id, recipe_id)`.
- **Aditiva:** nenhuma linha existente é alterada e não há preenchimento retroativo (testado em SQLite).
  - Encomendas antigas não têm linhas em `order_items`; o Worker as lê das colunas antigas.
  - Toda gravação nova grava **todos** os itens em `order_items` e repete o **primeiro** nas colunas antigas, que são `NOT NULL`.
- **Exclusão de receita:** passa a ser bloqueada também quando a receita é usada por qualquer item da encomenda, não só pelo primeiro.
- **Ordem obrigatória:** backup → migração 0012 → Worker → Pages. O Worker novo sem a 0012 falha fechado: não grava nada pela metade.
- **Rollback:** a migração é aditiva, então o Worker anterior tolera a tabela nova.
  - **Depois que existirem encomendas com vários itens, não volte o Worker para a versão anterior.** Ele leria só o primeiro item (das colunas antigas) e um app antigo poderia regravá-las incompletas.
  - Com o app novo isso não acontece: o Worker antigo responde 404 na rota v2 e o app não sincroniza.
  - Em caso de problema, corrija para a frente.

## 9. Sincronização e proteção contra versões incompatíveis

- **Protocolo novo:** o app usa `GET /api/sync/v2` e `POST /api/sync/v2/push` (`SYNC_PROTOCOL = 2`).
  - O pull declara `protocol: 2`.
  - O app **recusa** um pull sem essa declaração e não aplica nada.
- **Worker antigo:** responde 404 nas rotas v2. O app mostra "O servidor ainda não suporta encomendas com vários produtos…", não envia nada e mantém os dados no aparelho, inclusive os itens. Não há loop: vale o recuo exponencial habitual.
- **App antigo (cache):** o Worker novo responde **426 `CLIENT_OUTDATED`** nas rotas antigas, sem ler nem gravar. Um app antigo nunca regrava uma encomenda descartando itens que não conhece. Basta recarregar a página.
- **Inalterados:** local-first, offline, Web Locks, BroadcastChannel, revisões, conflitos (a lista de itens é comparada inteira), isolamento por conta e reconciliação financeira.

## 10. Testes

| Arquivo | Cobertura |
|---|---|
| `tests/order-items.test.ts` (34) | Cálculo (exemplo de R$ 277, preços fracionários, arredondamento, lucro, embalagens por receita, custo indisponível), status (todos os cenários da tabela), edição (histórico, item novo, troca de receita, remoção, total abaixo do recebido), receita repetida, resumo e busca, compatibilidade e backup, orçamento público (JSON, página, texto do WhatsApp), reconciliação, "manter minha versão" e migração dos metadados |
| `tests/order-items-sync.test.ts` (15) | Worker real em SQLite: ida e volta entre dois aparelhos, item incluído e removido offline, edição simultânea (conflito real), recebimentos em dois aparelhos (confirmação, reconciliação, reenvio sem duplicar), receita do 2º item protegida contra exclusão, validação no servidor, isolamento entre contas, rotas antigas (426), Worker antigo (404), pull sem protocolo, migração 0012 aditiva com encomendas antigas |
| `tests/ui/order-items.test.tsx` (6) | Adicionar, editar e remover produtos sem perder dados, resumo em tempo real, sinal opcional com aviso, validação, lista, tabela de detalhes, primeiro recebimento confirmando, edição preservando o histórico |

- **Mutações:** 10 mutações nas proteções principais foram detectadas pelos testes.
- **Testes antigos:** foram adaptados ao novo formato com os helpers de `tests/helpers/orders.ts`, que aplicam a mesma conversão do app. A expectativa de consultas ao baixar a conta subiu de 12 para 13, pela consulta de `order_items` (veja a política de custos).

## 11. Pendências de homologação

1. Conferir a lista remota de migrações; com autorização, fazer o backup e aplicar a 0012 no staging.
2. Publicar Worker e Pages de staging, na ordem e com autorização.
3. Repetir o exemplo de R$ 277 no navegador: criar, ver na lista, detalhes, link público, prévia e texto copiado. Confirmar que nenhuma embalagem aparece ao cliente.
4. Fazer um recebimento num orçamento: confirma; removê-lo: continua Confirmado.
5. Abrir a mesma conta em dois navegadores: incluir e remover itens offline e sincronizar.
6. Abrir pedidos antigos do staging: um item, valores, recebimentos e links intactos.
7. Uma aba antiga aberta durante a publicação deve mostrar o erro de sincronização e voltar a funcionar ao recarregar.
8. Verificar a responsividade em 320, 375, 390, 768, 1024 e 1440 px, inclusive no celular real.
