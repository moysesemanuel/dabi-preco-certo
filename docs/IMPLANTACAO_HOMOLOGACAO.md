# Implantação em homologação (roteiro, NÃO executado)

Este roteiro descreve como publicar o ambiente de **homologação**. Nada daqui foi executado: criar o banco, definir segredos, publicar o Worker e configurar domínio/DNS são ações **suas**, com credenciais da Cloudflare.

## 0. Decisões e pré-requisitos

- [ ] Conta Cloudflare com Workers e D1 (confirme os limites do plano gratuito e o que muda no plano pago; o projeto foi pensado para custo mínimo: bundle do Worker ~81 KiB).
- [x] **Provedor de e-mail: Resend** (adaptador pronto em `worker/src/email.ts`, testado só com API simulada). Domínio de envio `mail.dabitech.com.br` já verificado (São Paulo, sa-east-1); remetente `DaBi Preço Certo <acesso@mail.dabitech.com.br>`. Falta apenas a **chave de API** (seção 2). O adaptador `dev` só funciona com origens locais e nunca em ambiente publicado.
- [ ] Hospedagem do frontend: **Cloudflare Pages** (projeto estático apontando para `dist/`). O build gera `dist/_headers` (CSP, HSTS, etc.) — veja a seção 4.
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
npx wrangler secret put RESEND_API_KEY --env staging --config worker/wrangler.toml  # chave do Resend (re_...), colada no prompt
```
`EMAIL_ADAPTER="resend"` e `EMAIL_FROM` já estão em `[env.staging.vars]`. **Crie a chave no Resend com permissão só de envio ("Sending access") restrita ao domínio `mail.dabitech.com.br`** e use uma chave diferente para produção. Sem `RESEND_API_KEY` (ou com `EMAIL_FROM` inválido) o login responde 503 `EMAIL_NOT_CONFIGURED`: nada finge ser enviado. Nunca coloque a chave em arquivo versionado, no app ou em `VITE_*`.

## 3. Migrações

```bash
npm run d1 -- migrate --env staging        # mostra o banco de destino (dabi-orcamentos-staging) antes de aplicar
```
As migrações só **criam** tabelas e colunas (nenhuma apaga dados). Exporte um backup antes de migrações futuras. As migrações `0007_catalog_ref.sql` (referência do catálogo de medidas) e `0008_quote_code.sql` (código permanente do orçamento, com índice único por conta) devem ser aplicadas, nessa ordem, **antes** de publicar o Worker e o app desta versão (veja `docs/CATALOGO_DE_MEDIDAS.md` e `docs/CODIGO_DO_ORCAMENTO.md`).

## 4. Publicar o Worker e o app

```bash
npx wrangler deploy --env staging --config worker/wrangler.toml
VITE_API_URL=https://api-hml.seudominio VITE_REQUIRE_LOGIN=on npm run build   # gera dist/ e dist/_headers; publicar no Cloudflare Pages
```
`VITE_API_URL` precisa ser a origem **exata** da API: o build a coloca em `connect-src` da CSP (`dist/_headers`). Use um subdomínio do **mesmo domínio registrável** do app (cookie `SameSite=Lax`; `*.pages.dev` e `*.workers.dev` são sites **diferentes** entre si, então app e API publicados só nesses endereços não conseguem compartilhar a sessão — use domínios próprios ou o proxy local descrito em `DESENVOLVIMENTO.md`), ex.: `app-hml.dabitech.com.br` e `api-hml.dabitech.com.br`, e coloque só a origem do app em `ALLOWED_ORIGINS`.
Cabeçalhos aplicados pelo Pages a partir de `_headers`: CSP restritiva (scripts só do próprio site, sem iframes), HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` fechada, COOP/CORP e cache longo só em `/assets/*`. As fontes são servidas localmente (sem Google Fonts).
Configure rota/domínio do Worker e o DNS no painel da Cloudflare (manual).

## 5. Dados de teste (nunca clientes reais)

```bash
npm run licenses -- issue --env staging --email teste1@seudominio --label "homologação"
```
`--env staging` usa **exclusivamente** o D1 `dabi-orcamentos-staging` (Wrangler `--env staging --remote`); o CLI imprime ambiente e banco antes de agir e recusa `--remote` sozinho. Confira o banner (`Ambiente: staging`) e use a credencial da Cloudflare do ambiente de homologação.

## 6. Testes de fumaça

1. `GET /healthz` do Worker responde `{"ok":true}`.
2. Login por código com o e-mail de teste: o e-mail chega pelo Resend (confira o painel do Resend e a pasta de spam; verifique SPF/DKIM "pass" no cabeçalho). Teste também: pedir o código duas vezes em 60 s (só 1 e-mail), código errado 5 vezes (queima o código) e e-mail sem licença (nenhum e-mail).
3. Criar dados, sincronizar, abrir em um segundo navegador/dispositivo e conferir.
4. Terceiro dispositivo: deve pedir para desconectar um.
5. Publicar um orçamento, abrir o link **sem sessão** (aba anônima): sem custos, sem dados do cliente; revogar e ver `410`.
6. Estourar o limite de taxa de propósito e conferir o `429` com `Retry-After`.
7. Cabeçalhos da página pública: CSP sem scripts, `noindex`, `no-store`.
8. Fazer um backup (`npm run d1 -- export --env staging --output backup-hml.sql`) e restaurar no banco de ensaio (`npm run d1 -- restore-file --env restore --file backup-hml.sql`, depois de `wrangler d1 create dabi-orcamentos-restauracao` e de trocar o marcador de ID em `[env.restore]`).

## 7. Critérios para sair da homologação

Todos os itens ⬜ de **Operação** em `SEGURANCA_CHECKLIST.md` resolvidos ou aceitos por escrito, testes de fumaça aprovados e restauração de backup ensaiada.

## 8. Primeiro login real — o que precisa estar pronto
Veja a lista objetiva em `docs/ETAPA_1_PROGRESSO.md` ("Revisão do PR #1"): bancos D1, `AUTH_SECRET`, `RESEND_API_KEY`, domínios/rotas, publicação do Worker e do Pages, migrações e uma licença de teste com o seu e-mail.
