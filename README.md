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

**Status de verificação (2026-11-11):** `npm run build` (tsc + vite) conclui sem erros e `npm test` passa 5/5. Os testes cobrem apenas o domínio de precificação (`src/domain/pricing.ts`); validação de backup e interface ainda não têm testes.

## Estrutura

- `src/domain/types.ts`: tipos `Ingredient`, `Recipe`, `Order` e `DataSet` (`schemaVersion: 1`).
- `src/domain/pricing.ts`: `recipeCost` (custo total, unitário e preço sugerido; margem **sobre o preço de venda**: `custo / (1 − margem%)`), `normalizeQuantity` (kg↔g, l↔ml) e `money`.
- `src/storage/db.ts`: persistência no IndexedDB (`pedidocerto-v1`) e `validateBackup`.
- `src/App.tsx`: casca da aplicação (carregar/salvar dados, navegação, avisos). Repassa `data`, `update`, `inform` e `focus` às páginas.
- `src/pages/`: uma página por arquivo (`DashboardPage`, `IngredientsPage`, `RecipesPage`, `OrdersPage`, `BackupPage`), cada uma com seu próprio estado de formulário.
- `src/components/Field.tsx` e `src/utils.ts`: campo de formulário e utilitários compartilhados (`parse`, `newId`, `brDate`, `canPrice`, tipos `Page`/`PageProps`).
- `tests/pricing.test.ts`: testes unitários do domínio.

> Convenção do projeto: alterações que afetem o que está descrito aqui devem atualizar este README no mesmo trabalho.

## O que já está implementado

- Design system inicial, dashboard responsivo e navegação.
- Cadastro e exclusão de ingredientes com unidade, quantidade e preço de compra.
- Cadastro de receitas e seus ingredientes, rendimento, embalagem, mão de obra e extras.
- Cálculo de custo total, custo unitário e sugestão de preço por margem sobre venda.
- Cadastro de encomendas, mudança de status e cópia do texto de orçamento para WhatsApp.
- Armazenamento local no IndexedDB e exportação/importação de backup JSON.
- Testes unitários iniciais do domínio de precificação.

## Limitações deliberadas desta etapa

- Não é uma PWA instalável nem há suporte offline garantido após fechar/reabrir o navegador; isso exige service worker e testes adicionais.
- Sem login, servidor, pagamentos, licença ou sincronização entre dispositivos.
- O formulário de receitas usa as mesmas unidades cadastradas. O módulo de conversão está preparado, mas ainda não foi ligado à interface.
- Não há edição dos ingredientes/receitas; para alterar, será necessário excluir e cadastrar novamente (a exclusão é bloqueada se houver dependentes).
- O resumo financeiro mostra valores estimados e não substitui contabilidade.
- O backup faz validação estrutural básica. Regras relacionais, migrações e proteção contra arquivos adulterados precisam de reforço para lançamento.
- Não há cálculos de impostos, perdas, taxas de pagamento e capacidade de produção por lote no MVP.

## Próxima etapa proposta

1. Validar instalação, build e testes em ambiente com npm.
2. Testar fluxo completo em celular e desktop.
3. Adicionar edição segura dos cadastros, custo de taxas e perdas, capacidade de produção e análises de prazo.
4. Habilitar PWA offline com versão e política de atualização, mais testes e2e.

## Tokens de identidade

Azul `#101F35`, laranja `#FF861C`, creme `#FAF8F4`, verde `#16794A`, vermelho `#C43D3D`. Manrope (títulos) e Inter (texto).

## Privacidade

Dados de clientes ficam apenas no navegador; não são enviados ao servidor pelo código deste MVP. Backup gerado contém dados pessoais inseridos e deve ser guardado com cuidado. O projeto carrega fontes opcionais do Google Fonts quando há acesso à internet; para distribuição estritamente offline, hospede as fontes localmente.
