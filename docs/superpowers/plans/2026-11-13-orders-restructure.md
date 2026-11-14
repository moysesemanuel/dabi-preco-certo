# Etapa 10 — Implementação de encomendas e pedidos

> Plano executado pelo agente responsável; a instrução do usuário autoriza implementação autônoma e revisão posterior.

**Objetivo:** separar cadastro, lista e detalhes de pedidos, preservando o domínio existente e incluindo a cobrança de embalagens adicionais sem alterar encomendas históricas.

**Arquitetura:** rotas internas pelo History API, telas distintas e cálculos centralizados no domínio. A cobrança congelada por embalagem adicional será persistida em um campo aditivo opcional e sincronizada com D1.

**Tech Stack:** React 19, TypeScript, Vite, IndexedDB, Cloudflare Worker/D1, Vitest e SQLite local.

**Spec:** `docs/superpowers/specs/2026-11-13-orders-restructure-design.md`

## Restrições

- Não fazer deploy, push, merge ou escrita remota.
- Não alterar `worker/wrangler.toml`, secrets, DNS, usuários, D1 remoto ou backups.
- Preservar status persistidos, recebimentos, links públicos e snapshots legados.
- Não incluir alterações preexistentes da Etapa 9 em commits.

## Pontos de revisão

- Total/cobrança e recebimentos após editar pedidos com histórico.
- Compatibilidade de pedidos antigos sem `packagingCharge`.
- Preservação da cobrança no D1 quando cliente antigo omite campo.
- Rotas `/o/*`, links públicos e `/encomendas` legado.
- Filtro de status sem renomear valores armazenados.

## Tarefas

1. Adicionar testes de domínio para total cobrado, lucro, sinal vazio, saldo e preservação de pedido legado; criar cálculo central com arredondamento conforme regras atuais.
2. Adicionar `packagingCharge` opcional ao modelo e validador; criar migration 0011 e atualizar sincronização Worker/D1 para persistir e preservar o valor quando payload antigo o omitir; testar em SQLite.
3. Implementar formulário exclusivo de Nova encomenda com seções sequenciais, valores em tempo real, sinal opcional e gravação de snapshot.
4. Implementar lista independente de Pedidos com pesquisa local, filtros, estados vazios, linhas desktop e cards móveis.
5. Implementar detalhes com informações, composição financeira, recebimentos, status, cópia, link/revogação, edição e exclusão.
6. Integrar rotas internas e menu com caminhos estáveis, histórico/popstate e compatibilidade com `/encomendas`.
7. Adicionar testes de interface para navegação, exemplo de R$ 66,25, sinal de R$ 20, saldo R$ 46,25, legado e operações transferidas para detalhes.
8. Atualizar documentação de negócio, migration/deploy order, compatibilidade e checklist; executar regressão completa, typecheck, build, audit, secrets e diff check.

## Critério de conclusão

Suite local verde; migration 0011 validada em SQLite; nenhuma operação remota; documentação identifica explicitamente que staging exige migration 0011 após 0010, antes do Worker e Pages.
