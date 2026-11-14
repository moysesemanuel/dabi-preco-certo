# Etapa 10 — Design de encomendas e pedidos

## Intenção

Separar o cadastro de encomendas do acompanhamento de pedidos, facilitar o uso em celular e mostrar o total cobrado antes de informar um sinal. A tela de detalhes reunirá pagamentos, status e compartilhamento que hoje estão espalhados nos cards.

## Metas e limites

- Criar telas próprias para Nova encomenda, Pedidos e detalhes.
- Preservar as operações existentes de edição, recebimentos, status, cópia, link público, revogação e exclusão.
- Cobrar embalagens adicionais automaticamente e incluí-las uma única vez no custo/lucro.
- Preservar o total histórico de encomendas anteriores à mudança.
- Não mudar regras de status, API pública, URLs `/o/*`, autenticação ou infraestrutura remota.

## Abordagens consideradas

1. Manter formulário e lista juntos com nova aparência — descartada porque não separa os fluxos nem reduz a altura operacional.
2. Separar páginas usando o estado de navegação interno e adicionar rotas próprias no History API — escolhida; mantém a aplicação sem dependência de roteador e permite recarga/favoritos.
3. Adotar uma biblioteca de roteamento — descartada por aumentar dependências e escopo para poucas rotas internas.

## Decisões arquiteturais

- `/encomendas/nova`, `/pedidos` e `/pedidos/:id` serão rotas do cliente. `/encomendas` será tratado como rota legada para Pedidos. Rotas públicas `/o/*` permanecem fora do roteamento da aplicação.
- A lista terá pesquisa local por cliente, ORC, produto e filtro por status. O valor persistido `Produção` será apresentado como “Em produção”, sem migração de status.
- `Order.packagingCharge` é opcional e guarda em centavos o valor efetivamente cobrado pelas embalagens adicionais. Ausência equivale a zero, preservando encomendas e clientes antigos. D1 recebe uma coluna aditiva com default zero.
- Novo total = produtos arredondados em centavos + cobrança de embalagens adicionais arredondada em centavos. O custo estimado já soma as embalagens adicionais congeladas; lucro = total cobrado menos custo estimado.
- Encomendas novas salvam `packagingCharge`; editar encomenda antiga não a cobra retroativamente sem uma alteração explícita das embalagens no formulário.
- Sinal vazio é zero. Sinal e recebimentos existentes continuam sujeitos aos limites atuais, agora contra o total cobrado.
- Não será criado status cancelado, pois o modelo atual não o possui.

## Revisão de segurança/compatibilidade

O campo financeiro é validado no dataset, transferido pela sincronização e armazenado no D1. Pushes de clientes antigos que omitem o campo devem preservar o valor existente no D1 durante UPSERT. Datasets e registros legados sem o campo continuam válidos. Não é necessária alteração do contrato HTTP público de orçamento.

## Riscos

- A migração 0011 precisa ser aplicada no D1 antes da versão do Worker que escreve a coluna; nenhuma migração remota será executada nesta tarefa.
- Instâncias antigas do app podem omitir o campo. O Worker deve preservar a cobrança já persistida quando recebe um payload que não contém a propriedade.
- Não existe histórico de transições de status no modelo; detalhes mostrarão apenas o estado atual e os recebimentos disponíveis.
