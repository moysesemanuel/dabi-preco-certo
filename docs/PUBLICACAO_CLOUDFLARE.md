# Publicação na Cloudflare Pages (Etapa 6)

> **Estado em 13/11/2026:** staging está publicado. A API Cloudflare confirmou deployment canônico `a9efb520-07e2-428e-ac77-54d196a0ea01`, `APP_ENV=staging` e `API` → `dabi-orcamentos-staging` em Production e Preview. O texto abaixo é o roteiro histórico da Etapa 6; estado atual e plano de produção: [ETAPA_7_PREPARACAO_PRODUCAO.md](ETAPA_7_PREPARACAO_PRODUCAO.md).

> **Nada aqui foi executado contra a Cloudflare, a Vercel ou o DNS.** Esta etapa só preparou arquivos, scripts e testes locais. Quem executa os comandos remotos (e decide quando) é você. As regras de segurança continuam: nenhum segredo em arquivo versionado, `worker/wrangler.toml` e `backups/` não são alterados pelo repositório.

## 1. Arquitetura final

```
Navegador ── https://precocerto.dabitech.com.br ──► Cloudflare Pages (projeto dabi-preco-certo)
                                                   ├─ /*          arquivos estáticos (dist/) e rotas SPA (/admin…)   ← sem Functions
                                                   ├─ /api/*      Pages Function ─ Service Binding "API" ─► Worker dabi-orcamentos ─► D1
                                                   └─ /o/*        Pages Function ─ Service Binding "API" ─► Worker (links públicos de orçamento)
DNS: Vercel (nameservers atuais) ── CNAME precocerto → dabi-preco-certo.pages.dev     (o wildcard do Agendaí não é tocado)
```

- **Mesma origem, cookie de primeira parte.** App e API respondem no mesmo host, então o cookie `__Host-dabi_session` (HttpOnly, Secure, SameSite=Lax, sem Domain, `Path=/`) é de primeira parte e CORS não participa. O app é construído com `VITE_API_URL=same-origin`.
- **Sem proxy aberto.** `functions/_shared/proxy.ts` só encaminha `/api/*` e `/o/*` ao **Service Binding `API`** (definido no projeto Pages). A URL do cliente nunca escolhe o destino; `..`, `%2f`, `%5c` e métodos fora de GET/HEAD/POST/PUT/DELETE/OPTIONS são recusados. Corpos acima de 2 MiB são recusados antes de encaminhar (o Worker aplica os limites reais).
- **Fidelidade.** Método, corpo, cookies, `X-CSRF-Token`, `Origin`, `cf-connecting-ip`, status, `Retry-After` e vários `Set-Cookie` passam sem alteração. O único cabeçalho acrescentado é `X-Dabi-Expect-Env`. Falha do Worker vira 502 genérico; resposta sem `Cache-Control` ganha `no-store`.
- **`_routes.json`** (gerado em `dist/` pelo build): Functions só em `/api/*` e `/o/*`. O restante (incluindo `/admin`) é estático e **não consome a cota de Functions**.
- **SPA.** O Pages trata o projeto como SPA quando **não existe `404.html`**: `/admin` (ou qualquer rota do app) abre o `index.html` ao atualizar a página. O script de validação falha se um `404.html` aparecer em `dist/`.
- **Cabeçalhos.** `dist/_headers` (CSP com `connect-src 'self'`, HSTS, `X-Frame-Options`, `noindex` e `no-store` em `/admin`) vale para os arquivos estáticos. As respostas da API e dos links públicos têm os cabeçalhos do próprio Worker (CSP `default-src 'none'`, `no-store`).

## 2. Separação staging × produção (o que impede usar o banco errado)

| Camada | Staging | Produção |
|---|---|---|
| Projeto Pages | `dabi-preco-certo-staging` (`*.pages.dev`) | `dabi-preco-certo` (`precocerto.dabitech.com.br`) |
| Service Binding `API` → | Worker `dabi-orcamentos-staging` (D1 de homologação) | Worker `dabi-orcamentos` (D1 de produção, **ainda não criado**) |
| Variável `APP_ENV` (no projeto Pages) | `staging` | `production` |
| `ALLOWED_ORIGINS` do Worker | só o Pages de staging e localhost | **só** `https://precocerto.dabitech.com.br` |
| Script | `npm run pages:deploy:staging` | `npm run pages:deploy:production -- --confirm-production dabi-preco-certo` |

Camadas de proteção contra engano:
1. **Script com ambiente obrigatório**: sem `staging`/`production` no comando, nada roda; `deploy` sem `--publish` só constrói e valida; produção exige `--confirm-production dabi-preco-certo`.
2. **Projetos diferentes**, cada um com o seu binding. Nunca reaproveite um binding entre projetos.
3. **Guarda de ambiente no servidor**: o Pages envia `X-Dabi-Expect-Env: <APP_ENV>` (sobrescrevendo o do cliente); se o Worker tiver `APP_ENV` e ele não bater, responde **421** sem tocar no banco. Um Pages de homologação ligado por engano ao Worker de produção não consegue nada.
4. **CSRF/Origem**: o Worker de produção só aceita `POST` com `Origin` de produção; um front-end de homologação falha.
5. **Previews**: no projeto de **produção**, configure o binding do ambiente *Preview* para o Worker de **staging** (nunca o de produção) e `APP_ENV=staging`.
6. `GET /api/_edge/health` (respondido pelo próprio Pages, sem Worker) mostra `{ok, env, binding}` para conferir o projeto antes de testar.

## 3. Alterações propostas em `worker/wrangler.toml` (para sua revisão; não aplicadas)

Veja o diff pronto em **`docs/PROPOSTA_WRANGLER_TOML.diff`** (gerado contra a sua versão local; o seu arquivo não foi alterado). Resumo:
- staging: `ALLOWED_ORIGINS` passa a incluir `https://dabi-preco-certo-staging.pages.dev`; novo `APP_ENV = "staging"`.
- production: `ALLOWED_ORIGINS = "https://precocerto.dabitech.com.br"`, `PUBLIC_BASE_URL = "https://precocerto.dabitech.com.br"` (links `/o/…` pelo mesmo host), `APP_ENV = "production"`, `workers_dev = false` (a produção só é alcançada pelo Pages).
- Não crie `wrangler.toml` na **raiz** do repositório: com `pages_build_output_dir` ele passaria a ser a fonte da verdade do projeto Pages e sobrescreveria os bindings do painel.

Depois de editar, o Worker precisa ser publicado de novo (`npm run worker:deploy:staging`) para valer, e **antes** do Pages (o Worker novo já traz a guarda `APP_ENV` e as rotas `/api/admin`).

## 4. Teste local da cadeia completa (sem Cloudflare)

```bash
npm run pages:build:staging      # build com VITE_API_URL=same-origin + validação de dist/
# terminal 1 (Worker local; as variáveis abaixo são só do processo, não alteram wrangler.toml):
npx wrangler dev --local --config worker/wrangler.toml --var ALLOWED_ORIGINS:http://localhost:8788 --var APP_ENV:staging
# terminal 2 (Pages local com o binding para o Worker acima):
npm run pages:dev                # http://localhost:8788
```
Conferido nesta etapa: `/admin` e `/admin/clientes` → 200 (SPA); `/api/auth/session` → 401 JSON pelo Worker; login por código, `Set-Cookie` HttpOnly/SameSite=Lax (sem Secure só porque é http local), CSRF/origem recusando 403, logout 200 e depois 401; Worker com `APP_ENV` diferente → 421; `/api/admin/me` pelo proxy.

## 5. Criar e publicar o STAGING (comandos exatos)

Pré-requisito: `npx wrangler whoami` mostra a sua conta. Ordem importante: **Worker → projeto Pages → binding → deploy**.

```bash
# 0. Worker de staging com a guarda e a origem do Pages (depois de aplicar a proposta do §3 ao seu wrangler.toml)
npm run worker:dry-run:staging
npm run worker:deploy:staging

# 1. Criar o projeto Pages de staging (upload direto; nada é publicado ainda)
npx wrangler pages project create dabi-preco-certo-staging --production-branch staging

# 2. Configurar bindings e variável NO PAINEL (veja §6) e só então publicar:
npm run pages:deploy:staging:dry      # build + validação, sem enviar
npm run pages:deploy:staging          # publica (wrangler pages deploy dist --project-name dabi-preco-certo-staging --branch staging)
```

Conferência (substitua pelo endereço que a Cloudflare mostrar):
```bash
H=https://dabi-preco-certo-staging.pages.dev
curl -s $H/api/_edge/health                              # {"ok":true,"env":"staging","binding":true}
curl -s -o /dev/null -w "%{http_code}\n" $H/admin        # 200 (SPA)
curl -s -o /dev/null -w "%{http_code}\n" $H/api/auth/session   # 401
curl -s -o /dev/null -w "%{http_code}\n" $H/o/abcdefghijklmnopqrstuv   # 404 (página do Worker)
curl -sI $H/admin | grep -iE "x-robots|cache-control|content-security"
```

## 6. Configuração necessária do Service Binding (painel da Cloudflare)

Workers & Pages → projeto `dabi-preco-certo-staging` → **Settings → Bindings** (ou *Functions*):
1. **Add → Service binding**: *Variable name* `API`, *Service* `dabi-orcamentos-staging`. Faça nos ambientes **Production** e **Preview**, ambos para o Worker de staging.
2. **Add → Variable (texto)**: `APP_ENV` = `staging` (Production e Preview).
3. Refaça o deploy depois de salvar (as mudanças valem para novos deployments).

Para produção (futuro): projeto `dabi-preco-certo`, Production → `API` = `dabi-orcamentos`, `APP_ENV` = `production`; **Preview → `API` = `dabi-orcamentos-staging`, `APP_ENV` = `staging`**.

## 7. DNS na Vercel (`precocerto.dabitech.com.br`) sem afetar o wildcard do Agendaí

O wildcard `*.dabitech.com.br` do projeto `dabi_agendai` **não é alterado nem removido**. Um registro DNS explícito para `precocerto` tem precedência sobre o curinga (o curinga só responde por nomes sem registro próprio), então basta **adicionar um CNAME**.

1. Na Cloudflare: projeto Pages → **Custom domains → Set up a custom domain** → `precocerto.dabitech.com.br`. Ela mostrará o destino do CNAME (`<projeto>.pages.dev`).
2. Na Vercel: *Domains → dabitech.com.br → DNS Records → Add*: Tipo **CNAME**, Nome `precocerto`, Valor `dabi-preco-certo.pages.dev` (ou o projeto escolhido), TTL 60. Pela CLI: `vercel dns add dabitech.com.br precocerto CNAME dabi-preco-certo.pages.dev`.
3. **Não** adicione `precocerto.dabitech.com.br` como domínio de nenhum projeto Vercel (nem do `dabi_agendai`).
4. Aguarde a validação e o certificado (minutos). Conferir: `dig +short precocerto.dabitech.com.br CNAME` (deve apontar ao `*.pages.dev`) e `curl -sI https://precocerto.dabitech.com.br/api/_edge/health`.
5. Se a Cloudflare pedir validação por TXT, crie-a na mesma tela de DNS da Vercel.

**Atenção ao reverter:** se você **remover** o CNAME, o nome `precocerto` volta a cair no wildcard e passa a ser servido pelo **Agendaí**. Para desativar o app, remova primeiro o domínio personalizado no Pages só depois de decidir o que o wildcard deve responder (ou mantenha o CNAME apontando a uma página de manutenção do Pages).

Qual projeto recebe o domínio: para a fase de beta com dados de homologação, você pode anexá-lo temporariamente ao projeto **staging**; ao criar o D1/Worker de produção, mova-o para `dabi-preco-certo` (adicionar ao novo e remover do antigo; o CNAME muda de valor). Use sempre `APP_ENV` e `ALLOWED_ORIGINS` coerentes com o ambiente que o domínio serve (o Worker de staging precisaria incluir `https://precocerto.dabitech.com.br` em `ALLOWED_ORIGINS`).

## 8. Rollback

- **Front-end:** painel → projeto → *Deployments* → deployment anterior → *Rollback to this deployment* (instantâneo, sem rebuild). Ou publique de novo o commit anterior.
- **Proxy fora do ar:** apague o binding `API` no painel (as rotas `/api` passam a responder 503 `PROXY_NOT_CONFIGURED`; o app continua abrindo e usa os dados locais) e refaça o deploy.
- **Worker:** `npx wrangler rollback --env staging` (versão anterior; o banco não volta, mas as migrações são aditivas e o Worker antigo as tolera).
- **Banco:** Time Travel / backups (`docs/BACKUP_E_RECUPERACAO.md`).
- **DNS:** veja o aviso do §7 antes de remover o CNAME.

## 9. Custos e cotas (plano gratuito)

Arquivos estáticos do Pages não têm cota de requisições. Cada chamada `/api/*` ou `/o/*` passa por uma Pages Function e pelo Worker via Service Binding. A documentação atual da Cloudflare diz que, no modelo Standard usado pelo Pages de staging, a chamada ao Worker vinculado **não acrescenta uma requisição faturável**; a Function conta na cota Workers. Confirmar o uso real em *Functions Metrics* e na visão de cobrança após tráfego representativo. A hipótese histórica de dobrar as requisições não deve ser usada como previsão oficial; veja `POLITICA_DE_CUSTOS.md` e `ETAPA_7_PREPARACAO_PRODUCAO.md`.

## 10. Checklist de homologação (staging)

1. `npm run pages:deploy:staging:dry` sem erros (inclui `_routes.json`, `_headers`, ausência de `404.html`, segredos e endereços de Worker embutidos).
2. `/api/_edge/health` → `ok:true, env:"staging", binding:true`.
3. Abrir `/admin` e recarregar a página (F5): continua no painel (SPA). Abrir uma rota inexistente do app: carrega o app.
4. Login por código com e-mail real: cookie `__Host-dabi_session` com `HttpOnly; Secure; SameSite=Lax; Path=/` (DevTools → Application → Cookies); sem `Domain`.
5. Recarregar, fechar e reabrir o navegador: continua conectado.
6. Sincronizar uma alteração (CSRF/Origin funcionando pelo mesmo host); sair com a rede desligada: não confirma a saída.
7. `/admin`: conta comum vê "Acesso negado"; administrador entra.
8. Link público de orçamento: criar, abrir **sem login** em janela anônima (`/o/…` pelo Pages **e**, se `PUBLIC_BASE_URL` apontar para o Pages, o link devolvido pela API); revogar e ver "indisponível".
9. Guarda de ambiente: nunca vincule o Pages de staging ao Worker de produção; se alguém o fizer, a API deve responder 421.
10. **IP por cliente** (premissa a verificar): faça um `request-code` pelo Pages e confira no D1 qual chave de IP foi gravada:
    `npm run d1 -- query --env staging --command "SELECT license_id FROM rate_limits WHERE scope='login-request' AND license_id LIKE 'i_%' ORDER BY window_start DESC LIMIT 3"`
    e compare com `printf 'ip:SEU_IP_PUBLICO' | shasum -a 256` (precedido por `i_`). Se aparecer o hash de `ip:unknown`, o `cf-connecting-ip` não chegou ao Worker: todos os clientes dividiriam o limite de 30/h por IP (o limite por e-mail continua); nesse caso avise antes de ir a produção (a correção é encaminhar o IP em um cabeçalho próprio, aceito só vindo do binding).
11. Consumo: acompanhe requisições de Functions e do Worker no painel por alguns dias (§9).
12. Cabeçalhos: `curl -sI` em `/admin`, `/` e `/api/auth/session` (CSP, HSTS, `no-store`, sem `Set-Cookie` fora do login).

## 11. Riscos e pendências de segurança

- `*.pages.dev` do staging é público: só o login por licença protege os dados. Para restringir, a Cloudflare Access gratuita (até 50 usuários) pode proteger o projeto de staging.
- Cookie de primeira parte: um XSS no domínio do app seria mais grave que com domínios separados; por isso a CSP é restrita (`script-src 'self'`) e não há HTML do usuário no app.
- Deployments de Preview têm outra origem (`<hash>.<projeto>.pages.dev`): não estão em `ALLOWED_ORIGINS`, então não conseguem escrever (comportamento desejado).
- A premissa do IP por cliente e o consumo em dobro de requisições (§9, §10.10) ainda **não foram verificados em ambiente real**.
- O Worker de produção, o D1 de produção e seus segredos não existem; criar o ambiente de produção é uma etapa à parte.
- `GET /api/_edge/health` revela o nome do ambiente e se o binding existe (sem dados sensíveis).
