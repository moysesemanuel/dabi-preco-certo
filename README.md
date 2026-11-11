# PedidoCerto — MVP v0.1

Aplicação independente da DaBi Price. Stack: React 19 + TypeScript + Vite 6 + Tailwind CSS 4. Persistência local com IndexedDB.

## Executar

Requisitos: Node.js 20+.

```bash
npm install
npm run dev
```

Acesse a URL exibida pelo Vite (geralmente `http://localhost:5173`). Para executar verificações:

```bash
npm run build
npm test
```

**Status de verificação (2026-11-11):** `npm run build` (tsc + vite) conclui sem erros e `npm test` passa 27/27. Os testes cobrem o domínio (`pricing.ts`, `edit.ts`) e `validateBackup`; a interface ainda não tem testes.

## Estrutura

- `src/domain/types.ts`: tipos `Ingredient` (com `gramsPerCup` opcional), `Recipe`, `RecipeItem` (com `unit` opcional; ausente = unidade do ingrediente, compatível com dados antigos), `Order` e `DataSet` (`schemaVersion: 1`).
- `src/domain/pricing.ts`: `recipeCost` (custo total, unitário e preço sugerido; margem **sobre o preço de venda**: `custo / (1 − margem%)`), `convertQuantity` (peso, volume e medidas culinárias; volume↔peso usa `gramsPerCup`), `measureOptions` e `normalizeQuantity` e `money`.
- `src/domain/edit.ts`: funções puras de edição (`updateIngredient`, `updateRecipe`, `unitChangeAffectsRecipes`).
- `src/storage/db.ts`: persistência no IndexedDB (`pedidocerto-v1`) e `validateBackup`.
- `src/App.tsx`: casca da aplicação (carregar/salvar dados, navegação, avisos). Repassa `data`, `update`, `inform` e `focus` às páginas.
- `src/pages/`: uma página por arquivo (`DashboardPage`, `IngredientsPage`, `RecipesPage`, `OrdersPage`, `BackupPage`), cada uma com seu próprio estado de formulário.
- `src/components/Field.tsx` e `src/utils.ts`: campo de formulário e utilitários compartilhados (`parse`, `newId`, `brDate`, `canPrice`, tipos `Page`/`PageProps`).
- `tests/`: `pricing.test.ts`, `edit.test.ts` e `backup.test.ts`.

> Convenção do projeto: alterações que afetem o que está descrito aqui devem atualizar este README no mesmo trabalho.

## O que já está implementado

- Design system inicial, dashboard responsivo e navegação.
- Cadastro, **edição** e exclusão de ingredientes com unidade, quantidade e preço de compra. Editar o preço recalcula o custo das receitas; trocar a unidade exibe um aviso se houver receitas antigas sem unidade própria.
- Cadastro e **edição** de receitas (ingredientes, rendimento, embalagem, mão de obra e extras). Editar uma receita não altera encomendas já registradas, que guardam o próprio preço unitário.
- Cálculo de custo total, custo unitário e sugestão de preço por margem sobre venda.
- **Conversor de medidas** na receita: cada ingrediente pode ser lançado em g, kg, ml, l, xícara (240 ml), colher de sopa (15 ml) ou colher de chá (5 ml), e o app converte para a unidade de compra. Para converter xícara/colher em peso, o ingrediente (comprado em g/kg) guarda quanto pesa 1 xícara. Sem esse dado, a receita não é salva e o app avisa o motivo.
- Cadastro de encomendas, mudança de status e cópia do texto de orçamento para WhatsApp.
- Armazenamento local no IndexedDB e exportação/importação de backup JSON.
- Testes unitários do domínio de precificação, das funções de edição e da validação de backup.

## Limitações deliberadas desta etapa

- Não é uma PWA instalável nem há suporte offline garantido após fechar/reabrir o navegador; isso exige service worker e testes adicionais.
- Sem login, servidor, pagamentos, licença ou sincronização entre dispositivos.
- O peso de 1 xícara de cada ingrediente é informado manualmente (não há tabela de valores padrão). Itens `un` (unidade) não convertem para peso ou volume.
- Não há edição de encomendas (apenas o status muda); a exclusão de itens com dependentes é bloqueada.
- O resumo financeiro mostra valores estimados e não substitui contabilidade.
- O backup faz validação estrutural básica. Regras relacionais, migrações e proteção contra arquivos adulterados precisam de reforço para lançamento.
- Não há cálculos de impostos, perdas, taxas de pagamento e capacidade de produção por lote no MVP.

## Próxima etapa proposta

1. Testar fluxo completo (incluindo a edição de ingredientes e receitas) em celular e desktop.
2. Adicionar edição de encomendas, custo de taxas e perdas, capacidade de produção e análises de prazo.
3. Habilitar PWA offline com versão e política de atualização, mais testes e2e.

## Tokens de identidade

Azul `#101F35`, laranja `#FF861C`, creme `#FAF8F4`, verde `#16794A`, vermelho `#C43D3D`. Manrope (títulos) e Inter (texto).

## Privacidade

Dados de clientes ficam apenas no navegador; não são enviados ao servidor pelo código deste MVP. Backup gerado contém dados pessoais inseridos e deve ser guardado com cuidado. O projeto carrega fontes opcionais do Google Fonts quando há acesso à internet; para distribuição estritamente offline, hospede as fontes localmente.
