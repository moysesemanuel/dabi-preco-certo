# Ambientes e variáveis

## Ambientes

| Ambiente | Para quê | Banco | Como |
|---|---|---|---|
| **local** | Desenvolvimento | D1 local em `worker/.wrangler/` | `npm run worker:dev` |
| **staging** (homologação) | Testes integrados antes de produção | D1 `dabi-orcamentos-staging` (a criar) | `wrangler ... --env staging` |
| **production** | Clientes reais | D1 `dabi-orcamentos-producao` (a criar) | `wrangler ... --env production` |

Cada ambiente tem **banco, variáveis e segredos próprios**. `worker/wrangler.toml` já traz os blocos `[env.staging]` e `[env.production]` com marcadores no lugar dos IDs de banco (o deploy falha até serem trocados, de propósito). **Nada foi criado nem publicado.**

## Variáveis do app (build, públicas)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `VITE_API_URL` | não | Endereço da API (Worker). Em branco = app só local. Aceita `https` em qualquer host e `http` somente em `localhost`/`127.0.0.1`. Fica embutida no build: **não é segredo**. |

## Variáveis do Worker

Definidas em `worker/wrangler.toml` (não secretas) ou como segredos.

| Variável | Tipo | Descrição |
|---|---|---|
| `PUBLIC_BASE_URL` | variável | Origem pública dos links curtos de orçamento (sem barra final). |
| `ALLOWED_ORIGINS` | variável | Origens do app autorizadas (CORS e CSRF), separadas por vírgula. **Em produção, só a origem real do app.** |
| `LEGACY_KEY_AUTH` | variável | `off` (padrão): a autenticação antiga por chave de licença está desligada. |
| `EMAIL_ADAPTER` | variável | Vazio em produção até existir provedor de e-mail real (o login responde 503). `dev` só para desenvolvimento: imprime o código no terminal e **não entrega**. |
| `AUTH_SECRET` | **segredo** | Protege os códigos de login (HMAC). Aleatório, longo, exclusivo de cada ambiente. `wrangler secret put AUTH_SECRET --env <ambiente>`. Trocá-lo invalida os códigos pendentes (sessões abertas continuam). |

Em desenvolvimento, os segredos ficam em `worker/.dev.vars` (ignorado pelo git; veja `worker/.dev.vars.example`).

## Credenciais de operação (fora do repositório)

- **Cloudflare:** `wrangler login` ou `CLOUDFLARE_API_TOKEN` com escopo mínimo (Workers e D1 do ambiente). É a "credencial administrativa" que permite emitir licenças no banco remoto.
- Nunca use credenciais de produção em testes ou no CI.
