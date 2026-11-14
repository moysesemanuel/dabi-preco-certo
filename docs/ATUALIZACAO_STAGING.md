# Atualização controlada da homologação (staging)

## Etapa 11 — encomendas com vários itens (14/11/2026, local)

O candidato local acrescenta `worker/migrations/0012_order_items.sql` (aditiva) e troca a sincronização para `/api/sync/v2` (o Worker novo responde 426 às rotas antigas). Nada foi publicado nem aplicado remotamente. Ordem obrigatória, cada passo só com autorização:

1. Conferir o SHA aprovado e o checkout limpo; exportar e validar um backup novo do staging (`npm run d1 -- export --env staging --output backups/...`).
2. `npm run d1 -- migrations-list --env staging`: a única pendente deve ser `0012_order_items.sql` (0010 e 0011 já constam). Se houver outra, parar.
3. `npm run d1 -- migrate --env staging`.
4. `npm run worker:dry-run:staging` e depois `npm run worker:deploy:staging`.
5. `npm run pages:deploy:staging:dry` e depois `npm run pages:deploy:staging`. Entre os passos 4 e 5, abas abertas com o app antigo mostram erro de sincronização (426) sem perder dados; recarregar resolve.
6. Homologar pelo checklist de `docs/ETAPA_11_PEDIDOS_MULTIPLOS.md` §11.

Rollback: depois que existirem encomendas com vários itens, **não** volte o Worker; corrija para a frente (veja §8 do documento da etapa).


## Etapa 10 — reestruturação local de encomendas e pedidos (13/11/2026)

O trabalho local acrescenta a migração `0011_order_packaging_charge.sql`, dependente de `0010_packagings.sql`, e separa Nova encomenda, Pedidos e detalhes. A Etapa 9 informou que 0010 ainda não foi aplicada remotamente; esta tarefa não consultou nem alterou a Cloudflare e não aplicou as migrações. Antes de qualquer publicação, consulte a lista remota novamente: se ambas estiverem pendentes, aplique 0010 e depois 0011, somente após backup e autorização. Se o estado for diferente, pare e compare o esquema antes de publicar o Worker.

Use `docs/ETAPA_10_PEDIDOS.md` para as regras financeiras, compatibilidade, testes e checklist manual. A publicação futura deve seguir: confirmar o SHA aprovado → backup → migrações pendentes em ordem → Worker staging → Pages staging → homologação. Não publique Pages que cobre embalagem antes de o Worker/schema compatível estar pronto.

## Etapa 9 — preparação local de embalagens (13/11/2026)

Esta seção complementa o histórico abaixo. O candidato local inclui `worker/migrations/0010_packagings.sql`; esta tarefa **não consultou nem alterou** o estado remoto da migration 0010. Antes de publicar, consultar novamente o banco de staging. Se 0010 ainda estiver pendente, a ordem será:

1. Conferir branch/SHA aprovado e checkout limpo; exportar e validar um backup novo de staging.
2. `npm run d1 -- migrations-list --env staging` — conferir a lista real; nunca presumir que o ambiente remoto está no schema 0009.
3. Após autorização explícita: `npm run d1 -- migrate --env staging`, que aplica as migrations pendentes no D1 remoto. Parar se a lista incluir qualquer arquivo além de `0010_packagings.sql` ou se a saída divergir.
4. `npm run worker:dry-run:staging`; após a revisão manual exigida pelo script e autorização, `npm run worker:deploy:staging`.
5. `npm run pages:deploy:staging:dry`; conferir SHA completo no artefato e estado limpo; depois da autorização, `npm run pages:deploy:staging`.
6. Homologar catálogo, várias embalagens na receita, extras e sugestão manual por capacidade, snapshots, sincronização, backup e recuperação.

Não executar esta sequência como parte da auditoria local. A migration é aditiva, mas não há rollback SQL destrutivo seguro depois de novas escritas; rollback de aplicação exige versões Worker/Pages compatíveis entre si. Ver [`EMBALAGENS_E_PRECISAO_MONETARIA.md`](EMBALAGENS_E_PRECISAO_MONETARIA.md).

> **Registro histórico:** as migrações 0001–0009 constam no D1 remoto de staging em 13/11/2026; o Pages de staging está publicado. Não repetir os comandos de migração deste roteiro. Consulte [ETAPA_7_PREPARACAO_PRODUCAO.md](ETAPA_7_PREPARACAO_PRODUCAO.md) para estado atual e produção.

Este roteiro documenta a atualização histórica do staging, que à época tinha migrações 0001–0006 e Worker anterior. O estado atual já inclui as migrações 0001–0009.

> **Arquivo histórico; não executar novamente os comandos abaixo.** Esta etapa foi concluída no staging. Os comandos usam `--env staging` explícito, mas os resultados e contagens abaixo refletem o momento anterior à publicação.

| Recurso | Valor |
|---|---|
| Worker | `dabi-orcamentos-staging` — `https://dabi-orcamentos-staging.moyses-adm.workers.dev` |
| Banco D1 | `dabi-orcamentos-staging` (id configurado no seu `worker/wrangler.toml` local; **não versionado**, preservado) |
| Origem do app local | `http://127.0.0.1:5174` (já em `ALLOWED_ORIGINS`) |
| Segredos esperados (só nomes) | `AUTH_SECRET`, `RESEND_API_KEY` |

## 0. Estado e riscos (diagnóstico)

- **À época, pendente no staging:** migrações `0007_catalog_ref.sql` e `0008_quote_code.sql` e o Worker correspondente. Ambas agora constam no D1 remoto.
- **Migração aditiva `0009_admin.sql`:** era pendente quando este roteiro foi escrito; agora consta no D1 remoto. Detalhes em `docs/PAINEL_ADMINISTRATIVO.md`.
- **O backup `backups/dabi-staging-antes-0007.sql`** (15 KB, intocado; fora do Git via `.gitignore`) mostra o staging com **6 migrações aplicadas** (0001–0006), 1 usuário, 2 licenças, 2 ingredientes, 1 receita, **1 pedido com 2 recebimentos**, 6 sessões. Ensaio local com ele (ver §2): 0007+0008 aplicam sem tocar nada.
- **Descompasso hoje:** `npm run dev:staging` roda o app **novo** contra o Worker **antigo**. O Worker antigo descarta `catalogRef` e `quoteCode`; o app mantém tudo localmente e fecha o ciclo como "sincronizado", mas cria **conflitos "falsos" pendentes** (banner "Encontramos alterações diferentes") para cada ingrediente com referência e cada pedido novo (testado em `tests/ops`). **Nada se perde.** Até atualizar, evite criar pedidos/ingredientes com medidas no staging; se já criou, depois da atualização use **"Manter minha alteração"** em cada conflito (isso envia o código/referência).
- **Ordem obrigatória: banco → Worker → app.**
  - Worker novo com banco antigo: **leituras funcionam, gravações falham** (o `INSERT` usa colunas inexistentes; nada é gravado pela metade) — testado.
  - Worker antigo com banco novo: **funciona** (colunas opcionais, índice ignora `NULL`) — os testes do Worker anterior (commit `845cc67`: 134 testes de sync, auth, orçamentos e pagamentos) foram executados contra o esquema 0001–0008 e passaram. Logo **voltar o Worker não exige voltar o banco**.
- **Reverter o Worker NÃO reverte o esquema.** As migrações são aditivas e o Worker anterior as tolera; não há "desmigrar" (não existe `DROP` no plano).

## 1. Segurança das migrações 0007 e 0008

| Verificação | Resultado |
|---|---|
| Aditivas (sem `DROP`/`DELETE`/`UPDATE`/`TRUNCATE`) | Sim (teste confere o texto dos arquivos) |
| Dados existentes | Contagem de linhas e **impressão digital das colunas antigas** idênticas em todas as 12 tabelas, em dados sintéticos de 2 contas e **no backup real** |
| Colunas novas | `ingredients.catalog_ref TEXT` e `orders.quote_code TEXT`, ambas `NULL` nos registros antigos |
| 0008 e pedidos anteriores | Pedidos antigos ficam com `quote_code NULL` (**sem preenchimento no banco**); o app preenche um código **derivado do id** no primeiro carregamento e envia no sincronismo (só o código muda; valores, sinal, recebimentos e `cost_per_unit`/`cost_captured_at` ficam idênticos — testado) |
| Índice único | `UNIQUE (user_id, quote_code) WHERE quote_code IS NOT NULL`: **parcial**, então não falha com dados legados (muitos `NULL`); repetição na mesma conta é recusada; contas diferentes podem repetir; pedido excluído logicamente **continua reservando** o código |
| Colisão de códigos | Aleatórios: ~1 em 729 milhões por par; derivados: desempate determinístico; o servidor recusa repetição (`409 CODE_TAKEN`) e o app troca o código ainda não confirmado |
| Dependência 0007↔0008 | **Nenhuma** (tabelas diferentes; qualquer ordem dá o mesmo esquema). Mantenha 0007 → 0008 |
| Reaplicar | Falha (`duplicate column`): o Wrangler registra as aplicadas em `d1_migrations` e não repete |
| Preenchimento posterior | Não há etapa manual: ocorre pelo app, na primeira sincronização de cada aparelho (1 gravação por pedido antigo) |

Efeito esperado após a atualização: cada pedido antigo recebe `quote_code` na primeira sincronização; um segundo aparelho chega ao **mesmo** código (determinístico), sem conflito.

## 2. Testes locais (todos executados, sem rede)

```bash
npx tsc -b && npx vitest run         # 750 testes (inclui tests/ops: migrações em banco descartável)
npm run build                         # frontend
npm run worker:dry-run:staging        # Worker: empacota (92 KiB; 24 KiB gzip) sem publicar; mostra o banco e as variáveis de staging
npm run audit                         # 0 vulnerabilidades
BACKUP=backups/dabi-staging-antes-0007.sql npm run rehearse   # ensaio com o seu backup REAL, em memória
```

O ensaio com o backup real detecta as migrações aplicadas pelo `d1_migrations` (qualquer estágio: 0001–0006, 0001–0007 ou 0001–0008), restaura em SQLite descartável, simula **só as pendentes**, confere contagens e impressões digitais e simula a atribuição de códigos (resultado do dump atual: 12 tabelas idênticas; 1 pedido com código derivado único). Nada é lido nem escrito na Cloudflare.

## 3. Plano de atualização (a executar por você, nesta ordem)

Pare no primeiro resultado diferente do esperado e vá ao §5.

### Fase A — Backup e ponto de recuperação

```bash
# A1. Estado atual (somente leitura): migrações pendentes
npm run d1 -- migrations-list --env staging
#   esperado: só as migrações ainda não aplicadas (0007 e 0008; apenas 0008 se a 0007 já foi aplicada)

# A2. Contagens ANTES (somente leitura; guarde a saída)
npm run d1 -- query --env staging --command "SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM order_payments) AS payments, (SELECT COUNT(*) FROM ingredients) AS ingredients, (SELECT COUNT(*) FROM recipes) AS recipes, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM licenses) AS licenses"

# A3. Exportar o banco remoto (somente leitura). Use um nome novo: não sobrescreva o backup existente.
npm run d1 -- export --env staging --output backups/dabi-staging-antes-0007-0008-AAAAMMDD-HHMM.sql

# A4. Validar o arquivo
ls -l backups/dabi-staging-antes-0007-0008-*.sql                       # existe e NÃO está vazio
head -c 120 backups/dabi-staging-antes-0007-0008-*.sql                 # começa com PRAGMA ... CREATE TABLE
grep -c "^INSERT INTO" backups/dabi-staging-antes-0007-0008-*.sql     # > 0
grep -c "0006_prep_minutes.sql" backups/dabi-staging-antes-0007-0008-*.sql   # 1 (versão do esquema)
shasum -a 256 backups/dabi-staging-antes-0007-0008-*.sql               # registre o hash
git check-ignore -v backups/dabi-staging-antes-0007-0008-*.sql         # deve apontar para .gitignore (não versionado)
BACKUP=backups/dabi-staging-antes-0007-0008-AAAAMMDD-HHMM.sql npm run rehearse   # restaura em memória e aplica 0007/0008 de ensaio

# A5. Ponto de recuperação do D1 (Time Travel, 7 dias no plano gratuito) — anote o "bookmark" e o horário UTC
npm run d1 -- time-travel-info --env staging
```

**Interrompa** se: o arquivo estiver vazio/ausente; o hash/ensaio falhar; `migrations-list` mostrar algo além de 0007 e 0008.

### Fase B — Banco

```bash
npm run d1 -- migrate --env staging
#   O Wrangler lista as migrações a aplicar (0007, 0008) e pede confirmação: confira os nomes e responda y.
npm run d1 -- migrations-list --env staging                 # esperado: nenhuma migração pendente
npm run d1 -- query --env staging --command "SELECT name FROM d1_migrations ORDER BY id"   # 8 linhas, 0001…0008
npm run d1 -- query --env staging --command "PRAGMA table_info(orders)"        # deve conter quote_code
npm run d1 -- query --env staging --command "PRAGMA table_info(ingredients)"   # deve conter catalog_ref
npm run d1 -- query --env staging --command "PRAGMA index_list(orders)"        # deve conter idx_orders_quote_code (unique = 1, partial = 1)
# repita a consulta A2: TODAS as contagens devem ser idênticas às de antes
npm run d1 -- query --env staging --command "SELECT COUNT(*) AS sem_codigo FROM orders WHERE quote_code IS NULL"   # = total de pedidos (ainda não preenchido)
```

**Interrompa** se qualquer contagem mudar, se faltar coluna/índice, ou se `migrate` falhar (veja §5.1).

### Fase C — Worker (somente o de staging)

```bash
npm run worker:dry-run:staging                 # local: confirma banco dabi-orcamentos-staging e variáveis; nada é publicado
npx wrangler secret list --env staging --config worker/wrangler.toml     # só NOMES: esperado AUTH_SECRET e RESEND_API_KEY (nunca exiba valores)
npm run worker:deploy:staging -- --approved-commit <SHA40-aprovado> # publica Worker staging só com SHA aprovado e checkout limpo
curl -s https://dabi-orcamentos-staging.moyses-adm.workers.dev/healthz   # {"ok":true}
npx wrangler tail --env staging --config worker/wrangler.toml            # deixe aberto durante a Fase D; procure respostas 5xx/erros (Ctrl+C para sair)
```

**Interrompa** se `/healthz` falhar, se faltar um segredo, ou se o `tail` mostrar erros 5xx repetidos (§5.2).

### Fase D — Frontend (local) e homologação manual

```bash
# pare qualquer Vite antigo na porta 5174, depois:
npm run dev:staging          # http://127.0.0.1:5174  (mesmo endereço sempre; o cookie é por host)
```

Entre com o seu e-mail (um código chega por e-mail; vale 10 min). **Cada aparelho/navegador** enviará, na primeira sincronização, o código dos pedidos antigos. Se aparecerem conflitos de antes da atualização, resolva com **"Manter minha alteração"**.

## 4. Checklist de homologação manual

**Antes:** anote nº de pedidos, recebimentos, ingredientes e receitas (A2) e o saldo/total de um pedido existente.

### Ingredientes e conversor
- [ ] Digitar "Farinha de trigo": o resumo mostra "Medidas encontradas · 1 xícara ≈ 126,8 g" e salva só com nome, quantidade e preço.
- [ ] Ingrediente desconhecido: "Medidas não disponíveis", salva normalmente.
- [ ] Ajustar → peso personalizado (120 g): resumo "Medida personalizada"; "Restaurar valores do catálogo" volta à referência; "Remover referência" mantém o valor informado.
- [ ] Conversor: 2 xícaras de farinha → ≈ 253,6 g; 1/2 xícara; inverter; kg → g "Conversão exata".
- [ ] Mudar medidas de um ingrediente usado em receita: aviso diz quais receitas mudaram de custo; **encomendas antigas e custos registrados não mudam**.
- [ ] Recarregar a página: referências e valores persistem. Em outra sessão (anônima): as mesmas medidas chegam.

### Códigos de orçamento
- [ ] Pedido novo recebe `ORC-XXXXXX` acima do cliente; botão de copiar mostra "Copiado".
- [ ] Código igual após editar, mudar status, registrar pagamento e sincronizar na outra sessão.
- [ ] **Pedido antigo** já mostra código; o **valor, sinal, recebimentos e custo registrado** são os mesmos de antes.
- [ ] Gerar link de orçamento: o código aparece na página do cliente e na mensagem do WhatsApp; **revogar e gerar de novo**: mesmo código, novo link; o link revogado segue indisponível.
- [ ] Texto de "Copiar orçamento" traz o código.
- [ ] Nas duas sessões, o mesmo pedido mostra o mesmo código (sem conflito).

### Pesquisa
- [ ] "Pesquisar" parece um botão; ao clicar vira campo com foco e placeholder "Código, cliente ou produto...".
- [ ] Por código (com/sem `ORC-`, com/sem hífen), cliente, produto e status; com e sem acento.
- [ ] Limpar mantém o campo aberto; Fechar volta à lista completa; Esc limpa e depois fecha; estado vazio amigável.
- [ ] Celular (ou emulação): campo em largura total, sem rolagem horizontal.

### Integridade
- [ ] Sessão preservada (não pediu novo código) e seus dados continuam lá.
- [ ] Duas sessões: alterar o mesmo registro nas duas → conflito com comparação, nada sobrescrito.
- [ ] **Nenhum pagamento duplicado**: total recebido igual ao de antes; registrar um pagamento novo soma uma vez só.
- [ ] Indicador do cabeçalho verde sem conflitos; âmbar com conflito.
- [ ] Nenhum dado de outra conta aparece.

## 5. Recuperação (se algo der errado)

**Princípio:** o Worker anterior funciona com o esquema novo; o esquema novo é aditivo. Portanto o caminho normal de recuo é **reverter o Worker**, não o banco.

### 5.1 A migração falhou ou deu resultado inesperado (Fase B)
1. Não repita às cegas. `npm run d1 -- migrations-list --env staging` e `… query --command "SELECT name FROM d1_migrations ORDER BY id"` mostram o que foi aplicado.
2. Se só 0007 foi aplicada: corrija a causa e rode `migrate` de novo (aplica só a pendente).
3. Se os dados parecerem alterados (contagens diferentes): **não publique o Worker**. Avalie com o backup da Fase A.

### 5.2 O Worker novo apresenta erros (Fase C/D)
```bash
npx wrangler deployments list --env staging --config worker/wrangler.toml   # versões publicadas
npx wrangler rollback <VERSION_ID_ANTERIOR> --name dabi-orcamentos-staging --env staging --config worker/wrangler.toml --message "Rollback Custô staging" # restaura a versão anterior anotada
```
Não publique um `HEAD` arbitrário com `wrangler deploy` como atalho de rollback. Se a versão anterior não estiver disponível para rollback, pare e prepare um release anterior com SHA e checkout limpo antes de qualquer publicação. Depois do rollback do Worker, o app novo volta ao descompasso do §0 (conflitos "falsos"; nada se perde).

### 5.3 Dados corrompidos ou perdidos (último recurso)
1. **Time Travel** (7 dias): `npm run d1 -- time-travel-restore --env staging --timestamp <ISO-UTC do ponto anotado em A5>` — **substitui o estado atual do banco**; avise quem usa e anote o horário.
2. **Restaurar o `.sql` em banco novo** (nunca por cima do staging): crie o banco de ensaio (`npx wrangler d1 create dabi-orcamentos-restauracao`, coloque o id em `[env.restore]` no seu `wrangler.toml`), depois:
   ```bash
   npm run d1 -- migrate --env restore                                   # só se o dump não trouxer o esquema
   npm run d1 -- restore-file --env restore --file backups/dabi-staging-antes-0007-0008-AAAAMMDD-HHMM.sql
   npm run d1 -- query --env restore --command "SELECT COUNT(*) AS orders FROM orders"
   ```
   Confira as contagens e só então decida como usar os dados. (`restore-file --env staging` existe, mas **não use** sem decisão explícita: sobrescreve o banco de homologação.)
3. Ensaio local do procedimento, sem rede: `BACKUP=<arquivo.sql> npm run rehearse`.

## 6. Condições para considerar a atualização concluída

- `migrations-list` sem pendências; contagens iguais às de antes; coluna/índice presentes.
- `/healthz` ok e nenhum erro 5xx no `tail` durante o checklist.
- Checklist da §4 completo, sem pagamento duplicado e sem conflitos pendentes.
- Registrar em `docs/ETAPA_1_PROGRESSO.md` a data, os hashes dos backups e o resultado.

Depois disso, a publicação em **produção** continua exigindo autorização separada (mesma ordem: backup → migração → Worker → app, com a confirmação extra do CLI).
