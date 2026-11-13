# Etapa 7 — staging, produção e domínio

Estado consultado em 13/11/2026. Este documento prepara operações futuras; nenhuma infraestrutura de produção, DNS, secret ou backup foi alterado nesta etapa. Os oito testes manuais abaixo foram **relatados pelo proprietário em 13/11/2026**; a data exata de sua execução não foi informada.

**Investigação posterior do pico de consumo e guarda do release:** [DIAGNOSTICO_CONSUMO_STAGING.md](DIAGNOSTICO_CONSUMO_STAGING.md). A análise separa o tráfego anterior à publicação do Pages das invocações reais das Functions.

## Fase 1 — Staging publicado

Consultas de leitura à API Cloudflare e ao Wrangler confirmaram: Pages `dabi-preco-certo-staging`, branch `staging`, deployment canônico `a9efb520-07e2-428e-ac77-54d196a0ea01`; Production e Preview têm `APP_ENV=staging` e `API` → `dabi-orcamentos-staging` (ambiente do serviço `production`, entrypoint padrão). A versão ativa do Worker é `86fc9203-63f3-4b4a-8354-d4a12218352c`; seus bindings incluem `DB` com ID `6d6b478a-efe5-4ab1-a99e-07b6c5c1dc64`, `APP_ENV=staging`, `PUBLIC_BASE_URL=https://dabi-preco-certo-staging.pages.dev`, origem Pages e localhost, `LEGACY_KEY_AUTH=off`, `EMAIL_ADAPTER=resend` e nomes dos secrets `AUTH_SECRET`/`RESEND_API_KEY`. Os valores dos secrets não foram consultados. O D1 remoto contém 0001–0009 em `d1_migrations`. Na conta consultada, listas de Pages, Workers e D1 mostraram somente os recursos de staging.

**Testes manuais informados pelo proprietário:** login real pelo Resend; persistência da sessão; painel administrativo; cadastro de cliente; suspensão/reativação; sincronização entre dispositivos; links públicos; celular físico. São relatos, não testes executados pelo Codex nesta etapa.

**Verificações executadas pelo Codex nesta etapa:** `npm test` (942 aprovados, 2 ignorados), `npm run typecheck`, `npm run pages:deploy:production:dry` (somente build local), `npm run audit` (0 vulnerabilidades reportadas) e `npm run check:secrets` (sem padrões óbvios) passaram. Os testes não comprovam tráfego real de IP ou comportamento no domínio definitivo.

**Sondagens HTTP públicas nesta etapa, sem sessão:** `GET /api/_edge/health` respondeu 200 com `ok=true`, `env=staging`, `binding=true`; `GET /api/auth/session` e `GET /api/admin/me` responderam 401; `HEAD /admin` respondeu 200. Nenhum fluxo autenticado foi repetido pelo Codex.

### IP e rate limiting

`authRoutes.ts` usa `CF-Connecting-IP` ou `unknown`; a chave D1 é SHA-256 de `ip:<valor>`. Limites independentes: pedido 5/h e 12/dia por e-mail, 30/h por IP; verificação 15/h por e-mail e 60/h por IP; 5 tentativas por código; orçamento global de 80 e-mails/dia. Se o IP faltar, clientes dividem `ip:unknown`, mas os limites por e-mail e global permanecem. O proxy copia cabeçalhos; isso não comprova o IP entregue pelo Service Binding. Não confiar em `X-Forwarded-For` ou `X-Real-IP` enviado pelo navegador. A Cloudflare documenta comportamento diferente para subrequisições na mesma zona e entre zonas.

**Teste controlado pendente:** o próprio operador faz uma solicitação de código para sua conta licenciada pelo Pages. Calcula localmente `i_<SHA-256(ip:<seu IP público>)>` e consulta somente `COUNT(*)` dessa chave no escopo `login-request` e janela recente; compara também `i_<SHA-256(ip:unknown)>`. Não listar chaves de terceiros, IP completo, cookies ou tokens. Se não corresponder, interromper a expansão do beta para investigar; não desativar o limitador.

### Custos e métricas

`wrangler d1 info` informou 225 kB, 194.022 linhas lidas e 30.530 escritas nas 24 horas anteriores (110.521 consultas de leitura e 19.268 de escrita). GraphQL Analytics informou, em janela móvel de 24 horas, 13.826 invocações do Worker (13.823 `success`, 3 `clientDisconnected`), 0 erros de execução, 8 subrequisições, CPU P50 5.353 µs e P99 12.283 µs nas invocações `success`. A documentação do Workers Free indica 10 ms de CPU por requisição, com tolerância ocasional; o P99 acima de 10 ms não veio acompanhado de `exceededCpu` nesta consulta, mas requer acompanhamento em *Metrics → Errors → Invocation Statuses*. Não foi possível obter as invocações de Pages Functions pela consulta GraphQL ao nome do script Pages; verificar em *Pages → Functions Metrics* e na visão de uso faturável. Estes números são janelas móveis, não o dia da cota, e não identificam a causa do volume.

O Pages usa `usage_model=standard`. A documentação oficial informa: arquivos estáticos sem cobrança por requisição; Pages Functions na cota Workers; Service Binding no modelo Standard sem requisição adicional faturável (diferente dos modelos legados Bundled/Unbound). Portanto, a hipótese de duplicação por ação nos documentos antigos não é um limite oficial. Confirmar contagem faturável no painel após tráfego representativo. O uso de D1 observado equivale a cerca de **3,9%** do limite diário de 5 milhões de linhas lidas e **30,5%** do limite de 100 mil linhas escritas, com ressalva da diferença de janela. Investigar o volume de staging antes de abrir o beta.

## Fase 2 — Produção isolada, ainda não criada

Arquitetura: `precocerto.dabitech.com.br` → Pages `dabi-preco-certo` (estático e SPA em `/admin`; Functions apenas `/api/*` e `/o/*`) → Service Binding `API` → Worker `dabi-orcamentos` → D1 exclusivo `dabi-orcamentos-producao`. Build com `VITE_API_URL=same-origin` e `VITE_REQUIRE_LOGIN=on`. D1 e `AUTH_SECRET` próprios tornam sessões, usuários, licenças e auditoria independentes. Não copiar dados de staging.

**Diff proposto para revisão; não aplicado ao `worker/wrangler.toml`:**

```diff
 [env.production.vars]
-PUBLIC_BASE_URL = "https://orcamento.exemplo.com.br"
-ALLOWED_ORIGINS = "https://app.exemplo.com.br"
+PUBLIC_BASE_URL = "https://precocerto.dabitech.com.br"
+ALLOWED_ORIGINS = "https://precocerto.dabitech.com.br"
+APP_ENV = "production"
 LEGACY_KEY_AUTH = "off"
 EMAIL_ADAPTER = "resend"
```

Após criar o novo D1, substituir também **somente** o placeholder `env.production.d1_databases.database_id` pelo ID real, diferente do staging. Preservar `binding=DB`, `database_name=dabi-orcamentos-producao`, `workers_dev=false` e `EMAIL_FROM` verificado. `AUTH_SECRET` e `RESEND_API_KEY` devem ser secrets exclusivos de produção, nunca em arquivos versionados; não reutilizar automaticamente os de staging. O Worker de produção ainda não existe na conta consultada.

No Pages de produção, Production: `APP_ENV=production`, `API` → `dabi-orcamentos` (ambiente do serviço `production`, entrypoint padrão). **Preview: `APP_ENV=staging` e nenhum `API`**; o proxy retorna 503 em vez de alcançar dados reais. Se Preview funcional for necessário, criar isolamento próprio depois. Não anexar o domínio definitivo ao projeto de staging. Após o diagnóstico de consumo, o script de upload passou a exigir `main`, checkout limpo e SHA completo aprovado por `--approved-commit`; o PR #1 permanece em rascunho e não foi integrado nesta etapa.

### Ordem futura — operações remotas exigem autorização específica

1. `npx wrangler d1 create dabi-orcamentos-producao`; anotar ID e revisar diff do Wrangler. Recuo antes de dados reais: excluir apenas o banco novo.
2. `npm run d1 -- migrate --env production`; conferir `SELECT name FROM d1_migrations ORDER BY id` e `PRAGMA table_info(admins)`, `PRAGMA table_info(admin_audit)`, `PRAGMA index_list(orders)` com `npm run d1 -- query --env production --command '<consulta>'`. Aplicar 0001–0009 e qualquer migração posterior existente naquele momento. Banco novo não recebe dados de staging.
3. `npx wrangler deploy --dry-run --env production --config worker/wrangler.toml --outdir .wrangler/dry-run-production`; conferir nome, D1, URL, origens e `APP_ENV`. Só então `npx wrangler deploy --env production --config worker/wrangler.toml`. Com `workers_dev=false` e sem rota, o Worker inicial não recebe tráfego público. Recuo: rollback do Worker; esquema aditivo permanece.
4. Configurar secrets no Worker criado: `npx wrangler secret put AUTH_SECRET --env production --config worker/wrangler.toml` e `npx wrangler secret put RESEND_API_KEY --env production --config worker/wrangler.toml`; confirmar apenas nomes com `npx wrangler secret list --env production --config worker/wrangler.toml`. Cada `secret put` pode publicar uma nova versão; conferir a versão ativa antes de vincular o Pages. Não reutilizar o segredo de staging.
5. `npx wrangler pages project create dabi-preco-certo --production-branch main`; configurar Production/Preview como acima e conferir por API. `npm run pages:deploy:production:dry`; depois, a partir de `main` limpo, `npm run pages:deploy:production -- --confirm-production dabi-preco-certo --approved-commit <SHA40-aprovado>`. O script confere `HEAD` antes do build e do upload. Recuo: deployment anterior Pages.
6. Criar primeira licença **somente** com `npm run licenses -- issue --env production --email <email-do-proprietario>`; primeiro login normal; depois `npm run licenses -- grant-admin --env production --email <email-do-proprietario>` (confirmação de produção do CLI). Conferir `npm run licenses -- list-admins --env production`. Ninguém ganha admin por inferência.
7. Registrar ponto de recuperação com `npm run d1 -- time-travel-info --env production`; exportar produção com `npm run d1 -- export --env production --output <arquivo-novo-protegido>.sql` e ensaiar restauração em ambiente isolado. Nunca usar backup do staging. O CLI não permite `restore-file` diretamente em produção; `time-travel-restore` exige confirmação e análise da perda de escritas posteriores.

Para configurar o Pages recém-criado, a [API oficial de atualização de projeto](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/) aceita `PATCH /accounts/{account_id}/pages/projects/dabi-preco-certo` com este payload mínimo, **após GET para conferir o estado inicial e antes de qualquer deploy**:

```json
{
  "deployment_configs": {
    "production": {
      "env_vars": { "APP_ENV": { "type": "plain_text", "value": "production" } },
      "services": { "API": { "service": "dabi-orcamentos", "environment": "production" } }
    },
    "preview": {
      "env_vars": { "APP_ENV": { "type": "plain_text", "value": "staging" } }
    }
  }
}
```

O entrypoint padrão é indicado pela ausência de `entrypoint`. Conferir a resposta de um novo GET: Production tem `API` e `APP_ENV=production`; Preview tem `APP_ENV=staging` **e nenhuma chave `API`**. Se o GET inicial trouxer outras configurações, preservar todas; se o PATCH mesclar ou substituir mapas de modo inesperado, interromper e revisar antes de publicar.

Os testes automatizados cobrem isolamento por `user_id`, licenças, admin no servidor, duas sessões, CSRF, cookies, links públicos, erros genéricos e limites. Exige homologação real em produção antes de clientes. Suspensão preserva links públicos já emitidos; decidir explicitamente se essa política é aceitável e, se necessário, revogá-los manualmente. Não há exclusão automática.

## Fase 3 — Domínio definitivo

Em 13/11/2026, DNS autoritativo: NS `ns1.vercel-dns.com`/`ns2.vercel-dns.com`; `vercel dns ls dabitech.com.br` mostrou wildcard `*` como ALIAS e **nenhum registro explícito `precocerto`**. Uma resposta A para `precocerto` pode ser sintetizada pelo wildcard; não é prova de registro específico. O projeto Pages de produção ainda não existe, logo o alvo CNAME efetivo **não pode ser identificado agora**.

Ordem: (1) publicar e validar Pages de produção no subdomínio `*.pages.dev` que a Cloudflare efetivamente atribuir; (2) cadastrar `precocerto.dabitech.com.br` em *Custom domains* **do Pages de produção** e copiar o alvo CNAME mostrado; (3) verificar novamente na Vercel que não há registro `precocerto` nem associação indevida ao Agendaí; (4) criar **apenas** CNAME `precocerto` → alvo real; (5) validar DNS autoritativo, certificado TLS, domínio no projeto correto, health `production`, login, sessão, admin, bloqueio de usuário comum, sync, `/o/*`, WhatsApp, celular e redirecionamentos. Não alterar `*`, `www`, apex ou nameservers. CNAME não pode coexistir com A/AAAA específico no mesmo nome.

Com alvo confirmado, o comando da Vercel é `vercel dns add dabitech.com.br precocerto CNAME <alvo-real-do-Pages>`; consultar depois com `vercel dns ls dabitech.com.br` e `dig @ns1.vercel-dns.com precocerto.dabitech.com.br CNAME`. A [API de domínio Pages](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/) usa `POST /accounts/{account_id}/pages/projects/dabi-preco-certo/domains` com `{"name":"precocerto.dabitech.com.br"}`. Ambas são operações futuras que exigem autorização. Não preencher `<alvo-real-do-Pages>` com endereço presumido.

Com DNS externo, não presumir que regras WAF da zona Cloudflare atuem no host. Cloudflare exige associar o custom domain ao Pages; apenas apontar CNAME pode causar erro.

**Rollback:** reverter primeiro o deployment Pages ou servir manutenção pelo **Pages de produção**; se necessário, reverter o Worker. Não remover o CNAME como primeira medida: o host pode cair no wildcard do Agendaí. Planejar um destino explícito de manutenção antes de alterar/remover associação e CNAME. Rollback do Worker não restaura D1; usar backup/Time Travel só com avaliação do ponto de recuperação e dados dos clientes.

## Bloqueadores de implantação

- Revisão e autorização do diff do Worker, criação do D1 exclusivo e ID real; não publicar com placeholders.
- Selecionar e conferir o commit de release aprovado; o script Pages agora recusa branch diferente de `main`, checkout sujo ou SHA divergente. O deploy do Worker, ainda documentado como comando Wrangler direto, também exige conferência humana da revisão antes de executá-lo.
- Secrets próprios, projeto Pages próprio e Preview sem acesso ao Worker de produção.
- Confirmar alvo CNAME após criar o projeto; preservar wildcard.
- Validar IP real e explicar/acompanhar o volume de staging antes de ampliar o beta.
- Aceitar ou ajustar operacionalmente a política de links públicos após suspensão e ensaiar recuperação.

Fontes: [métricas Pages](https://developers.cloudflare.com/pages/functions/metrics/), [preços Pages](https://developers.cloudflare.com/pages/functions/pricing/), [preços e Service Bindings Workers](https://developers.cloudflare.com/workers/platform/pricing/), [CF-Connecting-IP](https://developers.cloudflare.com/fundamentals/reference/http-headers/), [domínios Pages com DNS externo](https://developers.cloudflare.com/pages/configuration/custom-domains/).
