# Worker de orçamentos compartilhados

Serviço remoto **mínimo** do DaBi Preço Certo. Ele existe só para publicar e consultar orçamentos que o vendedor quer enviar a clientes por link curto, por exemplo `https://orcamento.dabitech.com.br/o/K7mP9xQ2vL4nR8sT1wZ5aB`. O aplicativo continua local-first (IndexedDB) e **não depende** deste serviço para nada além de compartilhar orçamentos. Não é um SaaS: não há contas de clientes, painel nem sincronização.

## Estado atual (nenhum deploy, nenhum DNS)

| Funcionalidade | Estado |
|---|---|
| `GET /o/:id` página pública (HTML, sem JavaScript, mobile-first) | pronta |
| `GET /api/quotes/:id` JSON público + totais calculados | pronta |
| `POST /api/quotes`, `PUT /api/quotes/:id`, `DELETE /api/quotes/:id` | implementados e testados, **bloqueados**: respondem `501 PUBLISHING_DISABLED` |
| Autenticação de compradores | **não existe** (decisão pendente, ver abaixo) |
| Botão "Gerar link" no app | **não existe** de propósito; só será criado junto com a autenticação |

O bloqueio está em `src/index.ts`: o Worker exportado usa o autorizador `denyAll`. A autorização é checada **antes** de ler o corpo da requisição. Os testes injetam um autorizador falso para exercitar a escrita; não há caminho em produção para trocá-lo sem implementar autenticação de verdade.

## Estrutura

- `../shared/publicQuote.ts`: contrato `PublicQuote`, validação estrita, totais em centavos e formatação pt-BR (compartilhado com o app).
- `src/index.ts`: rotas, cabeçalhos de segurança e porta de autorização.
- `src/store.ts`: acesso ao D1 (somente consultas parametrizadas) e geração do id.
- `src/render.ts`: página pública, com todo texto escapado.
- `migrations/0001_quotes.sql`: tabela `quotes`.
- `wrangler.toml`: configuração **local** (ID de banco placeholder, sem rotas).

## Dados e privacidade

- Um orçamento publicado contém apenas o `PublicQuote`: nome e telefone do estabelecimento, número, datas, itens (descrição, quantidade, preço unitário em centavos), taxa de entrega, desconto e observações. Campos desconhecidos são **rejeitados**, então custo, margem, preço de compra, dados do cliente ou registros do IndexedDB não conseguem entrar.
- O total nunca é aceito de fora: é sempre recalculado a partir dos valores públicos.
- O id é aleatório (128 bits). Quem tem o link vê o orçamento; **não há autenticação para leitura**. Não coloque dados confidenciais nas observações.
- Limites: 50 itens, descrição 120 caracteres, observações 1.000, corpo de 16 KB, total máximo R$ 10 milhões.
- A página envia `noindex`, `no-store`, `Referrer-Policy: no-referrer` e uma CSP sem scripts. Erros não registram o conteúdo dos orçamentos.
- Revogar um link (`DELETE`) o torna indisponível (410). Alterar (`PUT`) atualiza o que o cliente vê no mesmo link. As duas ações exigirão ser o dono do orçamento.

## Desenvolvimento local

```bash
npm run worker:migrate   # cria o D1 local e aplica as migrações
npm run worker:dev       # sobe o Worker em http://127.0.0.1:8787
npm test                 # testes (inclui o Worker contra SQLite real)
```

Para ver uma página sem publicar, insira uma linha direto no D1 local com `wrangler d1 execute dabi-orcamentos --local --config worker/wrangler.toml --command "INSERT INTO quotes ..."`. O estado local fica em `worker/.wrangler/` (ignorado pelo git).

## Pendências antes de liberar a publicação

1. **Autenticação de compradores** (principal). Opções na seção abaixo; nenhuma foi implementada.
2. Cota por comprador e limitação de taxa (ex.: publicações por dia), para evitar abuso do D1.
3. CORS restrito à origem do app (hoje não há CORS, porque o app ainda não chama o Worker).
4. Criar o banco D1 real e trocar o `database_id` placeholder; configurar rota/domínio e DNS; deploy.
5. No app: configurações do negócio (nome e telefone), montagem do `PublicQuote` a partir da encomenda (`createPublicQuote`), prévia, copiar link e WhatsApp, com os avisos de limitação ao vendedor.
6. Política de retenção (limpeza de orçamentos antigos/revogados) e backup do D1.
7. Revisar LGPD: texto livre de observações pode conter dados pessoais.

## Opções simples e econômicas para autorizar compradores (não implementadas)

- **A. Chave de licença por compra.** Cada venda gera uma chave aleatória. O Worker guarda só o hash SHA-256 numa tabela `licenses` do D1 (com status e cota) e o app envia a chave em `Authorization: Bearer`. `owner_id` = id da licença. Revogar uma chave bloqueia só aquele comprador. Custo: zero além do plano gratuito; esforço pequeno.
- **B. Token assinado offline (Ed25519).** Você assina licenças com uma chave privada guardada fora do Worker; o Worker só tem a chave pública e verifica assinatura e validade. Sem tabela de compradores e sem estado. Para revogar, uma lista curta de bloqueio. Custo: zero; esforço pequeno a médio.
- **C. A ou B com emissão automática pelo gateway de pagamento.** Um webhook do pagamento aprovado emite e envia a chave por e-mail. Mais conveniente, porém mais peças (webhook, e-mail, tratamento de reembolso).

Em qualquer uma, manter cota por comprador e limitação de taxa.
