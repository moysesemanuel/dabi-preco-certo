# Implantação em homologação (roteiro, NÃO executado)

Este roteiro descreve como publicar o ambiente de **homologação**. Nada daqui foi executado: criar o banco, definir segredos, publicar o Worker e configurar domínio/DNS são ações **suas**, com credenciais da Cloudflare.

## 0. Decisões e pré-requisitos

- [ ] Conta Cloudflare com Workers e D1 (confirme os limites do plano gratuito e o que muda no plano pago; o projeto foi pensado para custo mínimo: bundle do Worker ~81 KiB).
- [ ] **Provedor de e-mail transacional** escolhido e adaptador escrito (`worker/src/email.ts`). Sem isso o login em homologação só funciona com `EMAIL_ADAPTER=dev` (código no terminal; **só** com `wrangler dev`, nunca em ambiente publicado).
- [ ] Hospedagem do frontend (pasta `dist/` é estática; qualquer hospedagem estática serve). Defina os cabeçalhos de segurança dela.
- [ ] Domínios de homologação (app e links de orçamento) no **mesmo site** (mesmo domínio registrável), por causa do cookie `SameSite=Lax`. Ex.: `app-hml.seudominio` e `orcamento-hml.seudominio`.

## 1. Banco (D1)

```bash
npx wrangler login                                   # credencial administrativa, na sua máquina
npx wrangler d1 create dabi-orcamentos-staging       # anote o database_id impresso
```
Troque `SUBSTITUIR-PELO-ID-DO-D1-DE-HOMOLOGACAO` em `worker/wrangler.toml` pelo ID real.

## 2. Variáveis e segredos

Edite `[env.staging.vars]` com os endereços reais (`PUBLIC_BASE_URL`, `ALLOWED_ORIGINS` = **só** a origem do app de homologação). Depois:

```bash
npx wrangler secret put AUTH_SECRET --env staging --config worker/wrangler.toml     # valor aleatório e longo
```

## 3. Migrações

```bash
npx wrangler d1 migrations apply dabi-orcamentos-staging --remote --env staging --config worker/wrangler.toml
```
As migrações só **criam** tabelas e colunas (nenhuma apaga dados). Exporte um backup antes de migrações futuras.

## 4. Publicar o Worker e o app

```bash
npx wrangler deploy --env staging --config worker/wrangler.toml
VITE_API_URL=https://orcamento-hml.seudominio npm run build       # publicar dist/ na hospedagem do frontend
```
Configure rota/domínio do Worker e o DNS no painel da Cloudflare (manual).

## 5. Dados de teste (nunca clientes reais)

```bash
npm run licenses -- issue --remote --email teste1@seudominio --label "homologação"
```
(Use `--remote` somente com a credencial de homologação ativa; confirme o banco antes.)

## 6. Testes de fumaça

1. `GET /healthz` do Worker responde `{"ok":true}`.
2. Login por código com o e-mail de teste (requer provedor de e-mail real).
3. Criar dados, sincronizar, abrir em um segundo navegador/dispositivo e conferir.
4. Terceiro dispositivo: deve pedir para desconectar um.
5. Publicar um orçamento, abrir o link **sem sessão** (aba anônima): sem custos, sem dados do cliente; revogar e ver `410`.
6. Estourar o limite de taxa de propósito e conferir o `429` com `Retry-After`.
7. Cabeçalhos da página pública: CSP sem scripts, `noindex`, `no-store`.
8. Fazer um backup (`d1 export`) e restaurar em outro banco de teste.

## 7. Critérios para sair da homologação

Todos os itens ⬜ de **Operação** em `SEGURANCA_CHECKLIST.md` resolvidos ou aceitos por escrito, testes de fumaça aprovados e restauração de backup ensaiada.
