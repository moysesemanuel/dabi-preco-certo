# Painel administrativo do proprietário (Etapa 5)

Rota do app: `/admin`. API: `/api/admin/*`. **Estado em 13/11/2026:** o staging publicado tem a migração `0009_admin.sql` no D1 remoto (consulta de leitura a `d1_migrations`) e o proprietário relatou acesso real ao painel, cadastro de cliente e suspensão/reativação aprovados. A data exata desses testes não foi informada. Este documento conserva a descrição de implementação; o plano de produção está em [ETAPA_7_PREPARACAO_PRODUCAO.md](ETAPA_7_PREPARACAO_PRODUCAO.md).

## 1. Diagnóstico da arquitetura existente (o que foi reaproveitado)

| Tema | Como já funcionava | Uso no painel |
|---|---|---|
| Cliente | `licenses` (1 linha por e-mail: `email`, `status active/revoked`, cotas, `user_id` preenchido no 1º login). `users` só nasce no primeiro login verificado | "Cliente" = licença com e-mail. Cadastrar = criar a licença; o usuário continua nascendo no 1º login |
| Suspensão | `licenses.status='revoked'` já derruba sync, links e novos logins (403/sem e-mail), sem apagar nada | Suspender = esse mesmo estado (sem inventar outro) |
| Sessões | `sessions` (hash do token, CSRF, `revoked_at`, expiração); máx. 2 ativas (INSERT atômico) | Listar e revogar por `UPDATE revoked_at`, na mesma tabela |
| Autenticação | Código de 8 dígitos por e-mail, cookie HttpOnly, CSRF (Origin + `X-CSRF-Token`) | **Nenhum segundo sistema de login**: o painel usa a mesma sessão |
| Scripts | CLI `npm run licenses` (emitir, revogar, listar) com ambiente explícito | Ganhou `grant-admin`, `revoke-admin`, `list-admins` |
| Isolamento | `user_id` em todas as consultas de dados | O painel **nunca** consulta `ingredients`, `recipes`, `orders`, `order_payments`, `quotes` nem `auth_codes` |
| Visual | `.card`, `.nav`, `.tag`, `.notice`, `Modal` acessível | Reutilizados; só `src/admin/admin.css` (poucas regras) |

## 2. Modelo de autorização

Administrador = **linha ativa em `admins`** para o usuário da sessão. Cada rota `/api/admin/*` decide **no servidor**, nesta ordem:
sessão válida (cookie HttpOnly) → conta não desativada → licença da conta **ativa** → linha ativa em `admins` → CSRF (se altera dados) → limite de taxa (120 leituras/min, 30 escritas/min por administrador).

- Nada vindo do cliente conta como prova: `role`, `admin`, e-mail no corpo, cabeçalhos (`X-Role`…) ou consulta são ignorados (testado).
- Quem não é administrador recebe sempre o mesmo `403`; sem sessão, `401`. Rotas desconhecidas sob `/api/admin` dão `404` sem exigir nada.
- **Suspender a licença do administrador, desativar a conta ou revogar a sessão tira o acesso na próxima requisição.**
- Não há rota para criar/conceder administradores. Códigos de orçamento e links públicos não dão acesso algum.
- Contas administrativas não podem ser suspensas nem desconectadas pelo painel (`409`), evitando que o proprietário se tranque por engano.
- Ações sensíveis (suspender, revogar todas as sessões) exigem **digitar de novo o e-mail do cliente**; o servidor confere (`confirmEmail`), não só a tela. Uma verificação por código de e-mail a cada ação gastaria a cota do Resend e não foi adotada (ver §9).

## 3. Migração preparada: `worker/migrations/0009_admin.sql`

Aditiva (só `CREATE`): tabelas `admins` e `admin_audit` e o índice `idx_licenses_created` (paginação). Não altera nem lê dados existentes. Ensaio em `tests/ops/migration-rehearsal.test.ts` (estágios 0001–0006/0007/0008 → 0009). **Já aplicada no staging; ainda não existe D1 de produção.** Para produção, ordem **banco → Worker → app**. Worker antigo com banco novo continua funcionando; Worker novo **sem** a 0009 responde 500 nas rotas `/api/admin` (as demais não são afetadas).

## 4. Criar o primeiro administrador (bootstrap)

Só pelo terminal do operador, nunca por tela ou rota pública:

1. Emita a licença do proprietário (se ainda não existe): `npm run licenses -- issue --env <amb> --email dono@exemplo.com`.
2. O proprietário faz o **primeiro login normal** pelo app (isso cria o usuário; ninguém vira administrador sem ter entrado antes).
3. `npm run licenses -- grant-admin --env <amb> --email dono@exemplo.com`
   - recusa se não houver usuário ativo com esse e-mail;
   - recusa se **já existe** um administrador ativo (só com `--additional`, decisão consciente);
   - em produção pede para digitar o e-mail (ou `--confirm-production <e-mail>`);
   - registra o evento `admin.grant` na auditoria (autor `cli`).
4. Revogar: `revoke-admin --env <amb> --email …`; listar: `list-admins --env <amb>`.

Usuários preexistentes **não** recebem acesso automaticamente.

## 5. Endpoints (todos sob autorização acima)

| Método e rota | Função |
|---|---|
| `GET /api/admin/me` | Confirma que a sessão é administrativa |
| `GET /api/admin/overview` | Indicadores (uma consulta agregada) |
| `GET /api/admin/customers?q=&status=&cursor=&limit=` | Lista paginada por cursor (25 por página, máx. 50) |
| `POST /api/admin/customers` `{email,label?,quotaActive?,quotaDaily?}` | Cadastra; idempotente por e-mail (201 criado / 200 já existia); **não envia e-mail** |
| `GET /api/admin/customers/:licId` | Detalhes, sessões ativas e últimos 20 eventos |
| `POST …/:licId/suspend` `{confirmEmail}` · `POST …/:licId/activate` | Suspender / reativar |
| `DELETE …/:licId/sessions/:sesId` · `POST …/:licId/sessions/revoke-all` `{confirmEmail}` | Revogar uma / todas as sessões |
| `GET /api/admin/audit?licenseId=&cursor=&limit=` | Histórico paginado (25, máx. 100) |

## 6. O que o painel mostra e o que não mostra

Mostra: totais de clientes (ativos, suspensos, aguardando 1º login, novos em 30 dias), sessões ativas, contas com algum dispositivo usado nos últimos 7 dias, e por cliente: ID da conta, e-mail, rótulo, situação, datas, último acesso, limites e dispositivos (rótulo, último uso, expiração).

**Não mostra nem consulta**: receitas, ingredientes, encomendas, valores financeiros, conteúdo de orçamentos, tokens de sessão, CSRF, códigos de login ou hash de licença (testado: nenhuma resposta administrativa contém esses campos).

**Limitações dos dados (sem coleta nova):** "último acesso" e "usou nos últimos 7 dias" vêm de `sessions.last_seen_at`, que o servidor atualiza no máximo a cada ~1 hora (precisão de cerca de 1 h). Não existem nem foram criadas métricas de uso interno do produto nem financeiras. O app não guarda nome do cliente: usa-se e-mail e rótulo administrativo opcional.

## 7. Política de suspensão

Suspender muda a licença para `revoked` e **mantém as sessões**: o cliente não sincroniza nem publica/atualiza links (403) e não recebe novos códigos de login, mas continua conectado vendo "A licença desta conta foi revogada" e pode **exportar backup**. Nenhum dado financeiro é apagado; outros clientes não são afetados (testado). Orçamentos já publicados continuam abertos até serem revogados (como no CLI; retirá-los é uma decisão à parte). Para derrubar dispositivos também, use "Revogar todas as sessões". **Não há exclusão física** de usuários ou dados nesta versão.

## 8. Auditoria

Tabela `admin_audit`: quando, quem agiu, ação, conta afetada, resultado (`ok` ou `noop`, ex.: suspender quem já estava suspenso) e um detalhe curto não sensível (`sessions=2`). A ação e o evento são gravados **no mesmo lote** (atômico). Ações negadas (quem não é administrador) **não** gravam nada, para que um cliente não encha a tabela. Retenção: eventos com mais de **365 dias** são apagados na próxima ação administrativa (consulta por índice). Tokens, códigos e dados privados nunca entram.

## 9. Custos e infraestrutura (veja `POLITICA_DE_CUSTOS.md`)

Sem serviço novo, sem polling (testado: 10 minutos parado = 0 requisições), sem carregar tabelas inteiras. Por ação: visão geral = 1 consulta agregada + 1 escrita de limite de taxa; lista = 1 consulta (25 linhas, subconsultas por índice) + 1 escrita; ação que altera = 1 lote (ação + auditoria) + 1 limpeza + 1 escrita de limite. Volume previsto: dezenas de ações por dia, desprezível frente aos 100 mil de escrita/dia. Binding `ratelimits`, Turnstile e R1–R6: **não usados**.

## 10. Proteções implementadas (testadas em `tests/admin-panel.test.ts` e `tests/ui/admin.test.tsx`)

Autorização no servidor (usuário comum e sessão revogada/desativada/licença suspensa recusados); sem escalada (corpo/cabeçalhos ignorados, sem rota de concessão, CLI só para quem já entrou); CSRF e origem; validação de e-mail, rótulo, cotas, cursor, filtros e IDs; corpo limitado (2 KB); consultas parametrizadas com `LIKE` escapado; paginação com teto; isolamento de sessões (id de sessão de outra conta = 404); idempotência e corrida no cadastro; auditoria; limite de taxa; **a tela só confirma o que o servidor confirmou** (falha de rede = "ação NÃO foi confirmada", logout honesto, sessão expirada volta ao login); `/admin` com `noindex` e `no-store`.

## 11. Checklist manual de homologação (antes de usar em produção)

1. **Histórico concluído no staging:** a 0009 está aplicada; não repetir a migração. Para produção, seguir o plano da Etapa 7 com D1 próprio.
2. Conceder administrador (§4) e entrar em `/admin` com o código real por e-mail.
3. Com uma conta comum (outro e-mail), abrir `/admin`: deve ver "Acesso negado".
4. Cadastrar cliente de teste (sem e-mail enviado); fazer o primeiro login dele; conferir "Aguardando 1º login" → conectado.
5. Suspender (digitando o e-mail): o cliente vê a mensagem de licença revogada, não sincroniza, consegue exportar backup; reativar.
6. Revogar uma sessão e todas; conferir que o dispositivo pede novo código.
7. Conferir o histórico (quem, ação, conta, hora).
8. Celular (320/375/390 px) e Safari/Firefox: login, lista, detalhe, modais, rolagem, botões de 44 px. O proprietário informou teste em celular físico no staging; matriz completa de navegadores não foi informada.
9. Desligar a rede e tentar suspender: a tela deve avisar que não foi confirmado.

## 12. Publicação futura em `https://precocerto.dabitech.com.br/admin`

- **Mesma origem, cookie de primeira parte.** Servir o app e a API no mesmo host elimina cookies entre sites: o cookie `__Host-dabi_session` (Secure, sem Domain, `Path=/`) já é compatível. Pré-requisitos: `ALLOWED_ORIGINS` com `https://precocerto.dabitech.com.br` (o `Origin` das requisições `POST` precisa estar na lista) e o app com `VITE_API_URL=same-origin`.
- **Arquitetura escolhida para produção:** Cloudflare Pages para o app; Pages Functions em `/api/*` e `/o/*` encaminham ao Worker por Service Binding `API`. O plano de configuração e isolamento do Preview está em `ETAPA_7_PREPARACAO_PRODUCAO.md`.
- O build já gera `_headers` com CSP (`connect-src 'self'`, ou a API) e cabeçalhos `noindex`/`no-store` para `/admin`; com Workers Static Assets, o arquivo `_headers` também é respeitado.
- O painel é um *chunk* separado (≈25 KB, 8 KB comprimido): clientes comuns nunca o baixam.
- Alternativa de defesa em profundidade (futura, gratuita): regra de acesso (Cloudflare Access gratuito para poucos usuários) na rota `/admin` **e** `/api/admin/*`, além da autorização do servidor.

## 13. Evolução futura (não implementada)

Verificação adicional por código de e-mail para ações sensíveis (gasta cota do Resend); mais papéis (`admins.role` já aceita extensão); exclusão definitiva com política de retenção/exportação; retirada de orçamentos públicos ao suspender; teto por conta (R4/R5); métricas de uso só se houver consentimento e coleta mínima.
