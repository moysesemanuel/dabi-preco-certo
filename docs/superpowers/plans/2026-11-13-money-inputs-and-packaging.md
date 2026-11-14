# Custô — campos monetários e embalagens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Padronizar a edição de valores monetários e incluir embalagem no custo da receita e da encomenda, com persistência offline e sincronização segura.

**Architecture:** `MoneyInput` fornece rascunho e parsing localizados. Embalagens tornam-se entidade versionada `packagings`; receitas guardam quantidades por unidade e encomendas guardam snapshots próprios. IndexedDB/backup, sync e D1 seguem os mecanismos existentes; migration 0010 é aditiva.

**Tech Stack:** React 19, TypeScript, IndexedDB, Cloudflare Worker/D1, SQLite via `node:sqlite`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-money-inputs-and-packaging-design.md`

## Global Constraints

- Não executar deploy, migração remota, D1 remoto, DNS, segredos, backups, produção, push ou merge.
- Não modificar `worker/wrangler.toml`.
- Preservar margem, preço de venda, recebimentos, sessões e contratos públicos existentes.
- Compatibilidade de leitura para esquemas/entidades antigos; snapshots históricos nunca são recalculados por preços atuais.
- Não arredondar custo unitário de embalagem antes de agregar o lote/ordem.
- Usar dados de teste fictícios e SQLite local.

## Review Focus

- `1 ÷ 200` de R$ 0,01 deve manter custo por unidade subcentavo até agregar a quantidade — cobrir no teste de domínio/captura de snapshot.
- Cliente antigo sem `packagings` no push/pull não pode apagar ou impedir sync; cobrir parser de push e pull compatível.
- Exclusão de uma embalagem ainda referenciada não pode quebrar receita em outra conta — cobrir erro referencial no Worker.
- `1.234,56`, `1,234.56`, `25,90`, `25.90`, valores parciais/vazios e texto inválido não podem produzir zeros ou centavos errados — cobrir parser e UI.
- Editar preço ou desativar embalagem não altera snapshot de encomenda anterior; cobrir integração SQLite real.

---

### Task 1: Campo monetário localizado

**Files:** `src/components/MoneyInput.tsx`, `src/domain/money.ts`, telas de ingredientes/receitas/encomendas/orçamento, testes `tests/money-input.test.ts`, `tests/ui/money-input.test.tsx`.

**Interfaces:** `parseMoneyInput(string): number | undefined` (vazio → undefined; inválido permanece inválido via NaN ou resultado discriminado). `MoneyInput` recebe `value`, `onChange`, `required`, `aria-describedby` e placeholder padrão `R$ 0,00`.

- [ ] Escrever testes de parser, edição, foco, limpeza, colagem, blur e validação.
- [ ] Executar testes novos e confirmar falha esperada.
- [ ] Implementar parser e componente mínimo.
- [ ] Substituir inputs monetários existentes sem tocar em quantidades/percentuais; dar semântica explícita a opcionais vazios.
- [ ] Rodar testes direcionados e a suíte.

### Task 2: Domínio de embalagens e cálculo preciso

**Files:** `src/domain/types.ts`, novo `src/domain/packaging.ts`, `src/domain/pricing.ts`, `src/domain/orderCost.ts`, `src/domain/edit.ts`, `shared/dataset.ts`, testes de domínio e backup.

**Interfaces:** `Packaging`, `RecipePackagingItem`, `OrderPackagingSnapshot`; funções de validação/custo unitário; `recipeCost(recipe, ingredients, cupSize, packagings)` retorna componentes sem arredondamento prematuro e valores de apresentação arredondados. `CostSnapshot` mantém custo base por unidade e total adicional congelado.

- [ ] Escrever testes para validação, custo unitário, multiplicidade, custo de lote, margem, snapshots, edição e compatibilidade antiga.
- [ ] Observar RED.
- [ ] Implementar entidades e funções puras.
- [ ] Estender validação/exportação/importação e migração tolerante local para versão atual.
- [ ] Observar GREEN e regressões.

### Task 3: Persistência e sincronização D1

**Files:** nova `worker/migrations/0010_packagings.sql`, `shared/sync.ts`, `src/sync/engine.ts`, `src/sync/resolve.ts`, `src/storage/db.ts`, `worker/src/sync.ts`, testes `tests/packaging-sync.test.ts`, `tests/ops/migration-rehearsal.test.ts`.

**Interfaces:** entidade versionada `packagings`; relação `recipe_packaging_items`; encomenda contém JSON de snapshots adicionais; novos payloads usam categoria `packagings`, enquanto o Worker aceita payload antigo sem a categoria.

- [ ] Escrever testes SQLite reais: aplicar migration 0010 a esquema 0001–0009 com dados, sync round-trip, conflito, isolamento, referencial e snapshot.
- [ ] Observar RED.
- [ ] Implementar migration aditiva, parsing, pull/push, CAS/soft-delete, validação de referências e compatibilidade legada.
- [ ] Rodar ensaio de migração e regressões de sincronização/autorização.

### Task 4: Interface de embalagens e associação em receitas

**Files:** `src/pages/PackagingsPage.tsx`, `src/pages/RecipesPage.tsx`, `src/App.tsx`, `src/components/Sidebar.tsx`, `src/utils.ts`, `src/domain/impact.ts`, estilos e testes de UI.

- [ ] Testar cadastro, edição, custo unitário, capacidade, vínculo múltiplo e impacto de custo.
- [ ] Observar RED.
- [ ] Implementar navegação e cadastro; permitir desativar itens referenciados e excluir apenas não referenciados.
- [ ] Implementar associação quantidade por produto e resumo de custos.
- [ ] Verificar operação responsiva em larguras de teste via browser quando disponível e rodar testes de UI.

### Task 5: Embalagens adicionais e snapshots na encomenda

**Files:** `src/pages/OrdersPage.tsx`, `src/domain/edit.ts`, `src/domain/orderCost.ts`, testes `tests/order-cost.test.ts`, `tests/payments.test.ts`, `tests/ui/packaging-orders.test.tsx`.

- [ ] Testar herança da receita, extras, sugestão editável, repetição explícita, alteração posterior de preço e saldo/recebimentos.
- [ ] Observar RED.
- [ ] Implementar campos de snapshot na criação/edição, cálculo da quantidade sugerida e seção separada.
- [ ] Rodar regressões de encomendas, pagamentos, link público e financeiro.

### Task 6: Documentação e regressão final

**Files:** `README.md`, `docs/POLITICA_DE_CUSTOS.md`, documentação de dados/sync e publicação de staging.

- [ ] Documentar decisão, migration 0010, backup/recuperação e ordem futura Worker antes de Pages.
- [ ] Executar `npm test`, `npm run typecheck`, `npm run build`, `npm run audit`, `npm run check:secrets`, `git diff --check`, testes direcionados de sync/auth/admin/quotes e ensaio migration.
- [ ] Revisar diff e estado do Git; não fazer deploy nem push.
- [ ] Criar commit local apenas se o estado não contiver alterações preexistentes alheias.
