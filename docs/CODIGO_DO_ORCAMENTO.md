# Código permanente do orçamento e pesquisa de pedidos

## O código

`ORC-` + 6 caracteres (ex.: **ORC-K7M42P**), alfabeto de 30 símbolos sem os ambíguos (0, 1, I, L, O, U): 30⁶ ≈ 729 milhões de combinações, fácil de ditar por telefone ou WhatsApp.

- **Gerado no aparelho, offline**, com números aleatórios criptográficos (`crypto.getRandomValues`, sem viés). Sem contador central, sem sequência, sem relação com o id interno nem com o token do link público.
- **Permanente**: gravado em `Order.quoteCode` na criação; editar, confirmar, entregar, receber pagamentos, publicar, revogar ou republicar links não o mudam. O servidor também o protege: se a encomenda já tem código, um envio com outro valor (ou sem código) não o altera.
- **Não é credencial**: não existe rota que consulte pedidos ou orçamentos pelo código. O link público continua usando o seu token de 22 caracteres, com validade e revogação próprias.

## Unicidade

1. O app só gera um código que ainda não existe nos pedidos que conhece (`uniqueQuoteCode`).
2. O servidor garante unicidade **por conta**: índice único parcial `(user_id, quote_code)` (inclui pedidos excluídos logicamente, para um código nunca ser reaproveitado) e conferência antes da gravação.
3. Se duas sessões gerarem o mesmo código offline (uma chance em centenas de milhões por par), o servidor responde `409 CODE_TAKEN` com os pedidos afetados; o app troca o código ainda não confirmado desses pedidos e reenvia. Nada é perdido e não há conflito para a pessoa resolver. Uma corrida entre dois envios simultâneos cai no índice único e é repetida pelo mesmo caminho.
4. Contas diferentes podem ter o mesmo código (cada conta é isolada).

## Pedidos existentes

Pedidos sem código recebem um código **derivado do id** (hash determinístico, não o id): todos os aparelhos chegam ao mesmo valor, então a sincronização não gera conflito. O código é preenchido ao carregar os dados e ao restaurar um backup; só o campo `quoteCode` é acrescentado (valores, recebimentos e custos registrados não mudam). Colisões entre códigos derivados são desempatadas sempre do mesmo jeito (por data e id). Regras de sincronização para esse campo de sistema:

- um aparelho que só acrescentou o código e outro que editou o pedido **não conflitam** (vale a edição, mantendo o código);
- se o servidor já tem um código, o aparelho o adota.

Links já publicados antes desta versão mantêm o número que tinham (são cópias imutáveis); novas publicações usam o código permanente.

## Onde aparece

Card do pedido (acima do cliente, com botão de copiar e confirmação "Copiado"), página pública do orçamento ("Orçamento nº ORC-…"), mensagem do WhatsApp, texto copiado do orçamento, lista de links publicados em Configurações, backup `.json` e sincronização.

## Pesquisa de pedidos

"Pesquisar" na lista de pedidos (parece um botão; ao clicar vira um campo com lupa, foco automático, filtro a cada tecla, "Limpar" e "Fechar"). Esc limpa o texto e, com o campo vazio, fecha; o campo fica aberto enquanto houver texto. Procura por **código** (com ou sem `ORC-`, com ou sem hífen, parcial), **cliente**, **produto/receita** e **status**, sem diferenciar caixa nem acentos; várias palavras precisam aparecer todas. Nunca procura em ids internos. A lista de pedidos não tem paginação (todos os pedidos estão no aparelho), então a busca sempre cobre todos.

## Migração (NÃO executada)

`worker/migrations/0008_quote_code.sql`: coluna `orders.quote_code` (opcional) e índice único parcial. Ordem: **migração → Worker → app**, depois da `0007`. Se o app novo sair antes do Worker novo, o servidor antigo descarta o campo e o app reenvia o código a cada sincronização.

Efeito esperado após a publicação: na primeira sincronização cada aparelho enviará uma atualização por pedido antigo (acrescentando só o código).
