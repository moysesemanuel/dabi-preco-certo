# Desenvolvimento local

## Requisitos

- **Node.js 22.18 ou superior** (os testes usam `node:sqlite`; o CLI de licenças executa TypeScript diretamente). Testado com Node 22 e 25.
- npm. Nenhuma conta da Cloudflare é necessária para desenvolver: o Worker e o D1 rodam localmente.

## Primeira vez

```bash
npm install
npm run build        # verifica tipos (app + Worker) e gera o build de produção
npm test             # ~400 testes (domínio, Worker com SQLite real, interface em jsdom)
```

## Rodar o app (somente local, sem conta)

```bash
npm run dev          # http://localhost:5174 (porta fixa em vite.config.ts)
```

Sem `VITE_API_URL`, o app funciona inteiro neste dispositivo (IndexedDB). A página **Configurações** mostra que o serviço online não está configurado.

## Rodar também o Worker local (conta, sincronização e orçamentos por link)

1. Prepare os segredos de desenvolvimento (arquivo ignorado pelo git):
   ```bash
   cp worker/.dev.vars.example worker/.dev.vars    # troque AUTH_SECRET por um valor aleatório
   ```
   `EMAIL_ADAPTER=dev` imprime o código de login no terminal do Worker; **não entrega e-mail**.
2. Crie o banco local e aplique as migrações:
   ```bash
   npm run worker:migrate
   ```
3. Emita uma licença de conta para o seu e-mail de teste:
   ```bash
   npm run licenses -- issue --env local --email voce@exemplo.com --label "dev"
   ```
4. Suba o Worker e o app. Use o **mesmo nome de host** nos dois (aqui, `localhost`), pois o cookie de sessão é `SameSite=Lax`:
   ```bash
   npm run worker:dev                                  # http://localhost:8787
   VITE_API_URL=http://localhost:8787 npm run dev      # http://localhost:5174
   ```
   `ALLOWED_ORIGINS` em `worker/wrangler.toml` já inclui `http://localhost:5174`.
5. Em **Configurações**, informe o e-mail, peça o código, copie-o do terminal do Worker e entre.

O estado local do D1 fica em `worker/.wrangler/` (ignorado pelo git). Apague a pasta para recomeçar do zero.

## Testar contra a homologação a partir do computador local

Não use `VITE_API_URL=https://...workers.dev` direto com o app em `127.0.0.1`: são **sites diferentes** e o cookie de sessão (`HttpOnly; Secure; SameSite=Lax`) não acompanha as chamadas entre sites. O código é aceito, mas a sessão não é reconhecida e a sincronização devolve 401 (foi a causa do login "que volta para a tela de entrada").

Use o proxy do Vite (só desenvolvimento), que deixa app e API na mesma origem:

```bash
npm run dev:staging      # http://127.0.0.1:5174  →  /api repassado para a API de homologação
```

Equivale a `DEV_API_PROXY_TARGET=<url da API> VITE_API_URL=same-origin VITE_REQUIRE_LOGIN=on vite --host 127.0.0.1`. O proxy só troca o nome do cookie (`__Host-dabi_session` ↔ `dabi_session`) e remove `Secure` na ida, porque o navegador local fala http; `HttpOnly`, `SameSite=Lax`, a checagem de `Origin` e o token CSRF continuam valendo. Abra sempre pelo **mesmo endereço** (`127.0.0.1` **ou** `localhost`, não os dois alternados: o cookie é por nome de host) e confirme que a origem usada está em `ALLOWED_ORIGINS` da API (`http://127.0.0.1:5174` e/ou `http://localhost:5174`). Para outra API, use as variáveis acima manualmente.

## Comandos úteis

| Comando | Para quê |
|---|---|
| `npm run build` | Tipos (app e Worker) + build de produção |
| `npm test` | Todos os testes |
| `npm run typecheck` | Só a verificação de tipos |
| `npm run audit` | Auditoria de dependências (severidade alta ou crítica) |
| `npm run check:secrets` | Procura segredos acidentais nos arquivos versionados |
| `npm run worker:migrate` | Aplica as migrações no D1 **local** (igual a `npm run d1 -- migrate --env local`) |
| `npm run d1 -- <comando> --env <ambiente>` | Migrar, exportar e restaurar o D1 com ambiente explícito (veja `BACKUP_E_RECUPERACAO.md`) |
| `npm run worker:dev` | Worker local com D1 local |
| `npm run licenses -- <comando> --env local\|staging\|production` | Emite, consulta e revoga licenças; o ambiente é sempre explícito (veja `worker/README.md`) |

## Estrutura

Veja a seção "Estrutura" do `README.md` e `worker/README.md`. Em resumo: `src/` (app), `shared/` (regras usadas pelo app e pelo Worker: validação, sincronização, orçamento público), `worker/` (API), `tests/` (inclui `tests/ui/` com testes de componente).

## Convenções

- Mudou algo documentado? Atualize o `README.md` (ou o documento correspondente) no mesmo trabalho.
- Regras de negócio ficam em funções puras (`src/domain/`, `shared/`) com testes; a interface só as chama.
- Nunca coloque segredos em arquivos versionados. `scripts/check-secrets.sh` roda no CI.
