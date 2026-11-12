# Worker de orçamentos compartilhados

Serviço remoto **mínimo** do DaBi Preço Certo. Ele existe só para publicar e consultar orçamentos que o vendedor quer enviar a clientes por link curto, por exemplo `https://orcamento.dabitech.com.br/o/K7mP9xQ2vL4nR8sT1wZ5aB`. O aplicativo continua local-first (IndexedDB) e **não depende** deste serviço para nada além de compartilhar orçamentos. Não é um SaaS: não há contas de clientes, painel nem sincronização.

## Estado atual (nenhum deploy, nenhum DNS)

| Funcionalidade | Estado |
|---|---|
| `GET /o/:id` página pública (HTML, sem JavaScript, mobile-first) | pronta, **sem autenticação** |
| `GET /api/quotes/:id` JSON público + totais calculados | pronta, **sem autenticação** |
| `POST /api/quotes`, `PUT /api/quotes/:id`, `DELETE /api/quotes/:id` | pronta, exige **chave de licença** |
| `GET /api/license` (verificar licença e ver o uso das cotas) | pronta, exige sessão (ou chave, se `LEGACY_KEY_AUTH=on`) |
| `GET /api/quotes` (listar os próprios links, com status e total) | pronta, exige sessão |
| Emissão, revogação e consulta de licenças | CLI local (`npm run licenses`); **não há endpoint público** |
| Tela Configurações no app (conta, dispositivos, sincronização, links publicados) | pronta |
| "Orçamento por link" no app (prévia, publicar, copiar, WhatsApp, revogar) | pronto |

## Estrutura

- `../shared/publicQuote.ts`: contrato `PublicQuote`, validação estrita, totais em centavos, formatação pt-BR.
- `../shared/licenseKey.ts`: formato da chave e leitura do cabeçalho `Authorization: Bearer`.
- `src/index.ts`: rotas, CORS, cotas e cabeçalhos de segurança.
- `src/auth.ts`: autorização por licença e limitação de taxa.
- `src/licenses.ts`: geração da chave (Web Crypto) e hash. `src/licenseAdmin.ts`: SQL de administração (validado).
- `src/store.ts`: acesso ao D1 (somente consultas parametrizadas, operações atômicas).
- `src/render.ts`: página pública, com todo texto escapado.
- `scripts/licenses.ts`: CLI administrativo.
- `migrations/`: `0001_quotes.sql` (orçamentos) e `0002_licenses.sql` (licenças, contadores de taxa e índices).

## Contas e sessões (Etapa 1, Fase 2)

O acesso do app passa a ser por **conta + sessão**; a chave de licença deixa de ser o fator de autenticação (o modo antigo continua no código, **desligado por padrão**, e só vale com `LEGACY_KEY_AUTH=on`).

- **Login sem senha:** o comprador informa o e-mail, recebe um **código de 8 dígitos** (válido por 10 minutos, uso único, no máximo 5 tentativas) e o digita. Não há senhas para armazenar nem vazar, e a **recuperação de acesso é o próprio login** (pedir novo código). O servidor guarda só um **HMAC-SHA256** do código (com o segredo `AUTH_SECRET`), pois 8 dígitos não resistiriam a um hash simples. Só existe um código ativo por e-mail.
- **Só entra quem tem licença:** a conta nasce no primeiro login verificado, e apenas para e-mails com uma licença ativa emitida (`licenses issue --email`). Não há cadastro aberto. Pedir código para um e-mail sem licença devolve **a mesma resposta** e não envia nada (não revela quem é cliente).
- **Sessão:** token aleatório de 256 bits em cookie `HttpOnly`, `SameSite=Lax` e, em https, `Secure` com prefixo `__Host-`. O servidor guarda só o SHA-256 do token. Validade de 30 dias; revogável.
- **CSRF:** operações que alteram dados exigem uma origem autorizada (`Origin` em `ALLOWED_ORIGINS`) **e** o token da sessão no cabeçalho `X-CSRF-Token` (obtido em `GET /api/auth/session`).
- **Até 2 dispositivos:** o terceiro login recebe `409 DEVICE_LIMIT` com a lista (sem tokens); o código continua válido e pode ser reenviado com `replaceSessionId` para trocar um dispositivo. A vaga é reservada de forma atômica (sem corrida entre logins simultâneos). `DELETE /api/sessions/:id` remove um dispositivo da **própria** conta.
- **Proteção contra tentativas repetidas:** a defesa principal é **por e-mail** (5 pedidos/hora; 15 verificações/hora) e **por código** (5 tentativas). O limite por IP (30 e 60/hora) é só uma rede de proteção ampla e **nunca é o único bloqueio**: trocar de IP não contorna o limite do e-mail, e um IP isolado não impede um e-mail de entrar por outro IP. Limitar por e-mail permite que alguém atrapalhe o login de outro (negação de serviço); isso **não derruba sessões já abertas**.
- **Licença revogada:** o CLI `revoke` encerra também as sessões. Se só a licença for revogada, as operações protegidas respondem `403 LICENSE_REVOKED`.
- **Isolamento:** o dono dos orçamentos é a licença da conta; outra conta recebe `404`.

Rotas: `POST /api/auth/request-code`, `POST /api/auth/verify-code`, `GET /api/auth/session`, `POST /api/auth/logout`, `GET /api/sessions`, `DELETE /api/sessions/:id`.

**E-mail:** `src/email.ts` define a interface `EmailSender` e o adaptador **Resend** (`EMAIL_ADAPTER=resend`, segredo `RESEND_API_KEY`, remetente em `EMAIL_FROM`). Sem configuração completa o login responde `503 EMAIL_NOT_CONFIGURED` (nada finge ter sido entregue). `EMAIL_ADAPTER=dev` só imprime o código no terminal e só vale com origens locais.

Segredos: `AUTH_SECRET` em `wrangler secret put AUTH_SECRET` (produção) ou `worker/.dev.vars` (desenvolvimento; veja `.dev.vars.example`).

Emissão: `npm run licenses -- issue --env <ambiente> --email comprador@exemplo.com` (licença de conta; a chave gerada é descartada), `bind <lic_id> --email ...` (vincula uma licença antiga), `revoke-sessions <lic_id>`. O ambiente é sempre explícito (veja "Fluxo de emissão manual").

## Dados online e sincronização (Etapa 1, Fase 3)

**Fonte autoritativa:** quando o usuário está logado e licenciado, o **servidor (D1)** é a fonte da verdade. O IndexedDB do app vira cache offline + alterações ainda não enviadas. Sem login, o app continua 100% local.

**Tabelas** (`0004_data.sql`): `sync_state`, `ingredients`, `recipes`, `recipe_items`, `orders`. Toda linha tem `user_id` (isolamento por conta; todas as consultas filtram por ele e usam parâmetros) e uma `rev`. Exclusões são **lógicas** (`deleted_at`): a sincronização nunca apaga dados do usuário de verdade. (Recebimentos entram na Fase 4.)

**Protocolo** (`shared/sync.ts`):
- `GET /api/sync?since=N` devolve as entidades com revisão maior que N (inclui exclusões lógicas); `since=0` devolve tudo.
- `POST /api/sync/push` envia até 100 alterações de uma vez. Cada gravação aceita aumenta a revisão da conta em 1.
- **Atomicidade e concorrência:** o envio é uma única transação (`D1.batch`). A primeira instrução só passa se a revisão da conta ainda for a que foi lida, e as demais só se aplicam se essa passou. Se outro dispositivo gravou no meio, responde `409 STALE` e **nenhuma** instrução é aplicada.
- **Conflitos:** se uma entidade enviada mudou no servidor depois da revisão que o cliente conhecia, o envio inteiro é recusado com `409 CONFLICT` e a lista dos itens. Reenviar algo idêntico ao que já está no servidor é aceito como "sem alteração" (idempotente), o que torna seguro repetir um envio cuja resposta se perdeu.
- **Integridade:** o conteúdo passa pelas mesmas regras do backup (`shared/dataset.ts`); receitas só apontam para ingredientes existentes, encomendas para receitas existentes, e não se exclui o que ainda é usado (`422 REFERENCE_ERROR`).
- Limites: 1 MB por corpo, 100 alterações por envio, 60 requisições/minuto por licença.

**Cliente** (`src/sync/`): `engine.ts` (puro) faz a mesclagem de 3 vias e divide o envio em blocos na ordem das dependências; `api.ts` é o cliente HTTP (cookie de sessão, CSRF no envio). Em conflito de uma **mesma entidade** (alterada aqui e em outro dispositivo a partir da mesma base) **nada é sobrescrito**: a versão local continua nos dados, a da nuvem e a base ficam em `meta.conflicts` (IndexedDB), o envio da entidade é retido e o usuário escolhe (`resolve.ts`: manter a minha / manter a da nuvem, com confirmação). Dinheiro de encomendas segue a reconciliação financeira explícita (`reconcile.ts`); ao manter a versão local de uma encomenda, recebimentos que existem na nuvem nunca são descartados. Se algo novo daqui depende de um item que outro dispositivo excluiu, o item é restaurado. Na primeira sincronização com dados dos dois lados e conteúdo diferente, o motor devolve `needs-decision` (nada é alterado até o usuário escolher). Falhas de rede, sessão expirada ou dados recusados interrompem sem perder nada.

## Licenças por chave (modo antigo, desligado por padrão)

- **Chave:** `dabi_lic_` + 24 bytes aleatórios em base64url (**192 bits**), 41 caracteres. Gerada com Web Crypto.
- **Armazenamento:** o D1 guarda somente o **SHA-256 (hex)** da chave em `licenses.key_hash`, mais um identificador interno do proprietário (`lic_` + 16 hex), status (`active`/`revoked`), cotas e rótulo administrativo. A chave nunca é gravada, registrada em log, colocada em URL nem devolvida em respostas.
- **Uso:** `Authorization: Bearer <chave>`. A chave na URL (`?key=`, `?access_token=`) **nunca** autentica. Ausente, malformada e desconhecida respondem igual (`401`); revogada responde `403 LICENSE_REVOKED`.
- **Propriedade:** o orçamento guarda o `owner_id` da licença que o criou. Quem não é o dono recebe `404` ao tentar atualizar ou revogar, como se o orçamento não existisse.
- **Efeito de revogar a licença:** ela deixa de poder publicar, atualizar e revogar. Os orçamentos já publicados **continuam acessíveis**, a menos que se use `--revoke-quotes` (retira todos do ar). Reativar a licença (`activate`) restaura o acesso.

### Cotas e limitação de taxa (por licença)

| Controle | Padrão | Resposta ao exceder |
|---|---|---|
| Orçamentos **ativos** (não revogados) | 100 (`quota_active`) | `429 QUOTA_ACTIVE_EXCEEDED`; revogar um libera espaço |
| Orçamentos **criados por dia** (dia no fuso do Brasil) | 30 (`quota_daily`) | `429 QUOTA_DAILY_EXCEEDED`; revogar **não** devolve a cota do dia |
| Escritas (criar, atualizar, revogar) | 20 por minuto | `429 RATE_LIMITED` com `Retry-After` |
| Verificações (`GET /api/license`) | 30 por minuto | `429 RATE_LIMITED` com `Retry-After` |

As cotas são aplicadas em **um único `INSERT … SELECT … WHERE`** e a limitação de taxa em **um único `UPSERT … RETURNING`**, ambos atômicos: requisições simultâneas não ultrapassam os limites (há testes de concorrência). A autorização e o limite de taxa vêm **antes** de ler o corpo da requisição. Requisições inválidas também consomem o limite de taxa.

### Fluxo de emissão manual

Pré-requisito: Node 22.18+ (o CLI executa TypeScript) e, para bancos remotos, as credenciais da Cloudflare do operador (`CLOUDFLARE_API_TOKEN` ou `wrangler login`). **Essas credenciais são a credencial administrativa**: sem elas não é possível emitir no banco remoto, e elas nunca devem ficar no repositório nem no app.

**O ambiente é sempre explícito** (`--env local|staging|production`; `--local` é sinônimo de `--env local`). `--remote` sozinho é **recusado**. Cada ambiente tem o seu banco e o seu `--env` do Wrangler:

| `--env` | Banco D1 | Wrangler |
|---|---|---|
| `local` | `dabi-orcamentos` (arquivo local) | `--local` |
| `staging` (homologação) | `dabi-orcamentos-staging` | `--env staging --remote` |
| `production` | `dabi-orcamentos-producao` | `--env production --remote` |

Antes de qualquer operação o CLI imprime **ambiente, banco e destino**. Combinações incoerentes (`--local` com `--env staging`, opções que não pertencem ao comando, id malformado…) param antes de tocar em qualquer banco.

```bash
# desenvolvimento (D1 local)
npm run worker:migrate
npm run licenses -- issue --env local --email voce@exemplo.com --label "dev" [--quota-active 100] [--quota-daily 30]

# homologação (D1 dabi-orcamentos-staging, remoto)
npm run licenses -- issue --env staging --email teste1@seudominio --label "homologação"

# produção (D1 dabi-orcamentos-producao, dados reais) — só com aprovação
npm run licenses -- issue --env production --email comprador@exemplo.com --label "Pedido 123"

npm run licenses -- list   --env staging
npm run licenses -- status   <lic_id> --env staging
npm run licenses -- activate <lic_id> --env staging
npm run licenses -- revoke   <lic_id> --env staging [--revoke-quotes]
npm run licenses -- revoke-sessions <lic_id> --env staging
```

**Produção, operações destrutivas** (`revoke`, `revoke-sessions`): exigem confirmação adicional, específica da licença. Interativo: o CLI pede para digitar o `lic_…`. Automação autorizada (sem terminal): `--confirm-production <lic_id>` com o **mesmo** id do comando; sem isso, nada é executado. Fora de produção a confirmação não existe e `--confirm-production` é erro.

**Migrações, backup e restauração** usam o mesmo controle (`npm run d1 -- <comando> --env <ambiente>`): `migrate`, `export --output arquivo.sql`, `restore-file --file arquivo.sql` (nunca em produção; use `time-travel-restore`), `time-travel-info`, `time-travel-restore --timestamp`. Em produção, `migrate`, `restore-file` e `time-travel-restore` pedem confirmação com o **nome do banco** (`--confirm-production dabi-orcamentos-producao`). Veja `docs/BACKUP_E_RECUPERACAO.md`.

1. O comando gera a chave, calcula o SHA-256 e envia **apenas o hash** ao D1 (a chave não vai em linha de comando nem em logs do Wrangler).
2. A chave completa é exibida **uma única vez** no terminal. Entregue-a ao comprador por um canal seguro e guarde só o ID interno (`lic_…`). Ela não pode ser recuperada; em caso de perda ou vazamento, emita outra e revogue a antiga.
3. O ambiente (`--env`) é obrigatório. Rótulos e identificadores são validados por padrão estrito antes de entrar no SQL.

## Dados e privacidade

- Um orçamento publicado contém apenas o `PublicQuote`. Campos desconhecidos são rejeitados, então custo, margem, preço de compra, dados do cliente ou registros do IndexedDB não conseguem entrar. O total é sempre recalculado.
- Quem tem o **link** do orçamento o vê; **não há autenticação para leitura**. Não coloque dados confidenciais nas observações.
- A página pública envia `noindex`, `no-store`, `Referrer-Policy: no-referrer` e uma CSP sem scripts. Erros não registram o conteúdo dos orçamentos nem chaves (há testes que espionam o `console`).
- CORS: apenas as origens em `ALLOWED_ORIGINS` (valor de desenvolvimento em `wrangler.toml`), sem cookies.

## No app

A página **Configurações** permite informar a chave, ativar/verificar (mostra licença válida, inválida ou revogada e o uso das cotas) e remover a chave do dispositivo. O endereço do serviço vem de `VITE_QUOTES_API_URL` (veja `.env.example`; só aceita `https`, ou `http` em localhost). A chave fica no `localStorage`, **fora do banco de dados do app e dos backups**. O armazenamento do navegador **não protege** contra quem acessa o dispositivo ou contra scripts maliciosos. As funções de precificação, receitas e encomendas não usam rede nem licença.

## Desenvolvimento local

```bash
npm run worker:migrate   # cria o D1 local e aplica as migrações
npm run worker:dev       # Worker em http://127.0.0.1:8787
VITE_QUOTES_API_URL=http://127.0.0.1:8787 npm run dev   # app falando com o Worker local
npm test
```

O estado local do D1 fica em `worker/.wrangler/` (ignorado pelo git).

## Pendências (segurança e publicação)

O Worker **não está pronto para produção**: as cotas, a autorização por proprietário e a limitação de taxa estão implementadas e testadas, mas faltam itens operacionais.

1. **Proteção contra inundação de requisições sem licença.** O limite de taxa é por licença; chaves inválidas só passam pela checagem de formato antes de uma consulta ao D1. Configurar uma regra de limitação de taxa por IP no WAF da Cloudflare para `/api/*` (e, se necessário, Turnstile).
2. **Deploy:** criar o D1 real, trocar o `database_id` placeholder, aplicar as migrações (`npm run d1 -- migrate --env staging|production`), configurar rota/domínio e DNS, e definir `ALLOWED_ORIGINS` com a origem real do app.
3. **Token administrativo da Cloudflare** com escopo mínimo (apenas D1) e guardado fora do repositório. Não há trilha de auditoria de emissões além de `created_at` e do rótulo; considerar registrar quem emitiu e quando.
4. **Limite de taxa em janela fixa:** permite rajadas de até 2× o limite na virada do minuto. Aceitável para esta etapa; usar janela deslizante se virar problema.
5. **Chave no `localStorage`** é legível por scripts da mesma origem. Manter o app livre de scripts de terceiros e de `dangerouslySetInnerHTML`.
6. **Rotação de chave:** hoje é manual (emitir outra e revogar a antiga). Não há endpoint de autoatendimento.
7. **No app:** montar o `PublicQuote` a partir da encomenda, prévia, publicar, copiar link e WhatsApp, com os avisos de limitação ao vendedor (o botão "Gerar link" ainda não existe).
8. Retenção/limpeza de orçamentos antigos e revogados, backup do D1 e revisão de LGPD (texto livre pode conter dados pessoais).
9. Fluxo comercial: emissão automática após pagamento, reembolso/cancelamento e suporte (fora do escopo desta etapa).
