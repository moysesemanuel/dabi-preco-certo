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
   npm run licenses -- issue --local --email voce@exemplo.com --label "dev"
   ```
4. Suba o Worker e o app. Use o **mesmo nome de host** nos dois (aqui, `localhost`), pois o cookie de sessão é `SameSite=Lax`:
   ```bash
   npm run worker:dev                                  # http://localhost:8787
   VITE_API_URL=http://localhost:8787 npm run dev      # http://localhost:5174
   ```
   `ALLOWED_ORIGINS` em `worker/wrangler.toml` já inclui `http://localhost:5174`.
5. Em **Configurações**, informe o e-mail, peça o código, copie-o do terminal do Worker e entre.

O estado local do D1 fica em `worker/.wrangler/` (ignorado pelo git). Apague a pasta para recomeçar do zero.

## Comandos úteis

| Comando | Para quê |
|---|---|
| `npm run build` | Tipos (app e Worker) + build de produção |
| `npm test` | Todos os testes |
| `npm run typecheck` | Só a verificação de tipos |
| `npm run audit` | Auditoria de dependências (severidade alta ou crítica) |
| `npm run check:secrets` | Procura segredos acidentais nos arquivos versionados |
| `npm run worker:migrate` | Aplica as migrações no D1 **local** |
| `npm run worker:dev` | Worker local com D1 local |
| `npm run licenses -- <comando>` | Emite, consulta e revoga licenças (veja `worker/README.md`) |

## Estrutura

Veja a seção "Estrutura" do `README.md` e `worker/README.md`. Em resumo: `src/` (app), `shared/` (regras usadas pelo app e pelo Worker: validação, sincronização, orçamento público), `worker/` (API), `tests/` (inclui `tests/ui/` com testes de componente).

## Convenções

- Mudou algo documentado? Atualize o `README.md` (ou o documento correspondente) no mesmo trabalho.
- Regras de negócio ficam em funções puras (`src/domain/`, `shared/`) com testes; a interface só as chama.
- Nunca coloque segredos em arquivos versionados. `scripts/check-secrets.sh` roda no CI.
