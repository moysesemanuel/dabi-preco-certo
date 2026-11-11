# Etapa 1 (beta) — Progresso

Branch: `feat/etapa-1-beta`. Nada foi publicado, nenhum DNS foi alterado e nenhuma credencial real foi usada.

## Fase 1 — Integridade financeira e persistência local: CONCLUÍDA

**Feito**
- **Snapshot de custo por encomenda** (`Order.costSnapshot`): o custo unitário da receita é registrado ao criar a encomenda e **nunca é recalculado** com preços atuais. Mudar preço de ingrediente ou a receita não altera o custo histórico.
- **Política para encomendas antigas** (sem snapshot): permanecem sem snapshot. O app as mostra como **"custo estimado com os preços atuais"**, nunca como custo registrado. Nenhum custo histórico é inventado na migração. O painel informa quantos pedidos entram como estimativa. Se o custo não for calculável, é "indisponível" (nunca zero).
- Editar uma encomenda preserva o snapshot; só trocar a **receita** a registra de novo (se o custo não for calculável, o registro antigo é removido para não manter o custo de outro produto).
- **Esquema v2** com migração tolerante dos dados já gravados no navegador (`migrateStored`: nunca rejeita nem apaga) e **validação estrita** de backups (`validateDataSet`, em `shared/dataset.ts`, reutilizável pelo servidor): ids duplicados/inválidos, relacionamentos (item→ingrediente, encomenda→receita), valores monetários e quantidades inválidos (NaN, Infinity, negativos, texto, > R$ 1 bi), sinal > total, datas reais, status, snapshot, limites de tamanho. Campos desconhecidos são descartados. Backups v1 continuam aceitos.
- **Fila de gravação serializada** (`src/storage/saveQueue.ts`): gravações no IndexedDB ocorrem uma por vez e em ordem, coalescidas (o último vence). A restauração de backup passa pela mesma fila.
- Formulários validam dinheiro/quantidade (`src/domain/money.ts`) e arredondam para centavos.

**Testes:** +30 (`dataset`, `save-queue`, `order-cost`). Total após a fase: 241.

**Decisões**
- Valores em reais (float com arredondamento a centavos) foram mantidos; migrar tudo para centavos inteiros seria invasivo e sem ganho nesta etapa. Os valores são validados e arredondados nas bordas.
- Dados gravados no navegador **não** passam pela validação estrita (poderiam ser rejeitados e ficar ilegíveis); só backups e sincronização.
- O teste de backup "versão desconhecida" passou de `schemaVersion: 2` para `3` porque a versão 2 agora é válida (mudança legítima de contrato, não para esconder defeito).

**Riscos / pendências**
- Várias abas abertas ao mesmo tempo ainda podem sobrescrever uma à outra no IndexedDB (a fila protege apenas dentro de uma aba). Será tratado pelo controle de revisão da sincronização (Fase 3).
