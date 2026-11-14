# Etapa 10 — Nova encomenda e gestão de pedidos

## Arquitetura

A navegação agora separa o cadastro (`/encomendas/nova`), a lista (`/pedidos`) e os detalhes (`/pedidos/:id`). A rota antiga `/encomendas` continua abrindo a lista. O app usa History API e o fallback SPA já usado pelo Pages; endpoints e rotas públicas `/o/*` não mudaram.

Os status persistidos seguem `Orçamento`, `Confirmado`, `Produção` e `Entregue`. A interface apresenta `Produção` como “Em produção”. O modelo não possui status de cancelamento, então a Etapa 10 não inventa nem persiste um status novo. Estado operacional continua independente de recebimentos.

## Regra financeira das embalagens

Embalagens da receita permanecem no custo congelado da receita e não alteram o preço cobrado em duplicidade. Embalagens adicionais da encomenda geram snapshots de custo e são automaticamente cobradas. A regra central está em `src/domain/orderFinancials.ts`:

```text
total cobrado = arredondar(quantidade × preço unitário) + cobrança congelada de embalagens adicionais
custo estimado = custo congelado/estimado dos produtos + custo das embalagens adicionais
lucro estimado = total cobrado − custo estimado
saldo = total cobrado − sinal − recebimentos posteriores
```

Exemplo testado: 25 unidades × R$ 2,50 + uma caixa de R$ 3,75 = **R$ 66,25**; sinal de R$ 20,00 deixa **R$ 46,25**. A prévia de orçamento público inclui uma linha “Embalagens adicionais” quando a cobrança é positiva, sem expor custo unitário, identificadores internos ou margem.

`Order.packagingCharge` guarda o valor cobrado no momento do pedido. Ausência significa zero em pedidos antigos. Os itens e custos permanecem snapshots; a alteração posterior do catálogo não recalcula pedidos existentes. Links públicos já publicados continuam imutáveis.

## Persistência e compatibilidade

A migração aditiva `0011_order_packaging_charge.sql` cria a coluna `orders.packaging_charge` com default zero. Ela depende da migração local `0010_packagings.sql`; executar 0011 sem 0010 não é suportado. Nenhuma migração remota foi executada. Antes da futura publicação, consultar o estado remoto e aplicar somente as migrações realmente pendentes, após backup e autorização.

O Worker mantém a cobrança já persistida quando recebe um pedido de cliente antigo que omite o novo campo. No sync, ausência e zero são equivalentes para evitar conflitos artificiais de registros legados; cobrança positiva continua diferenciada. A exportação/importação e a validação de datasets preservam o campo quando aplicável.

Rollback de aplicação deve reverter Pages e Worker para versões compatíveis. A migração é aditiva e não deve ser desfeita com `DROP`; não há rollback SQL destrutivo seguro depois que a nova versão aceitar cobranças. Consulte `docs/ATUALIZACAO_STAGING.md` antes de qualquer publicação.

## Verificações locais

Os testes cobrem navegação e recarga das rotas, pedido legado sem cobrança retroativa, total e saldo de exemplo, orçamento público, recebimentos, sync com clientes antigos e migração em SQLite descartável. Testes automatizados não substituem homologação manual em celular e navegador após a publicação.

## Homologação manual futura

- [ ] Abrir `/encomendas` e confirmar que a lista antiga continua acessível; abrir `/pedidos` e `/encomendas/nova` diretamente e recarregar.
- [ ] Pesquisar por cliente, código ORC e produto; testar cada filtro operacional e estado vazio.
- [ ] Criar pedido sem sinal e com sinal; validar produtos, embalagem adicional, total, custo, lucro e saldo em tempo real.
- [ ] Confirmar 25 × R$ 2,50 + caixa R$ 3,75 = R$ 66,25; R$ 20,00 de sinal = R$ 46,25 de saldo.
- [ ] Testar duas embalagens por produto, embalagem adicional sobreposta intencionalmente, quantidade manual e sugestão por capacidade.
- [ ] Editar pedido com recebimentos existentes; tentar reduzir total abaixo do recebido e confirmar recusa sem perda dos recebimentos.
- [ ] Mudar status até Entregue mantendo saldo pendente; confirmar independência do estado financeiro.
- [ ] Abrir pedido antigo com embalagens e confirmar que seu total e recebimentos não mudaram.
- [ ] Copiar orçamento; publicar link; conferir total no link e WhatsApp; revogar e confirmar que links anteriores seguem suas regras.
- [ ] Sincronizar em duas abas/dispositivos, testar offline e reconectar, e confirmar que não há duplicidade nem conflitos artificiais.
- [ ] Repetir os fluxos em larguras de 320, 375, 390, 768, 1024 e 1440 px; verificar teclado, foco e ausência de rolagem horizontal.
