# Etapa 1 (beta) — Progresso

Branch: `feat/etapa-1-beta`. Nada foi publicado, nenhum DNS foi alterado e nenhuma credencial real foi usada.

## Fase 1 — Integridade financeira e persistência local: CONCLUÍDA

**Feito**
- **Snapshot de custo por encomenda** (`Order.costSnapshot`): o custo unitário da receita é registrado ao criar a encomenda e **nunca é recalculado** com preços atuais. Mudar preço de ingrediente ou a receita não altera o custo histórico.
- **Política para encomendas antigas** (sem snapshot): permanecem sem snapshot. O app as mostra como **"custo estimado com os preços atuais"**, nunca como custo registrado. Nenhum custo histórico é inventado na migração. O painel informa quantos pedidos entram como estimativa. Se o custo não for calculável, é "indisponível" (nunca zero).
- Editar uma encomenda preserva o snapshot; só trocar a **receita** a registra de novo (se o custo não for calculável, o registro antigo é removido para não manter o custo de outro produto).
- **Esquema v2** com migração tolerante dos dados já gravados no navegador (`migrateStored`: nunca rejeita nem apaga) e **validação estrita** de backups (`validateDataSet`, em `shared/dataset.ts`, reutilizável pelo servidor): ids duplicados/inválidos, relacionamentos (item→ingrediente, encomenda→receita), valores monetários e quantidades inválidos (NaN, Infinity, negativos, texto, > R$ 1 bi), sinal > total, datas reais, status, snapshot, limites de tamanho. Campos desconhecidos são descartados. Backups v1 continuam aceitos.
- **Fila de gravação serializada** (`src/storage/saveQueue.ts`): gravações no IndexedDB ocorrem uma por vez e em ordem, coalescidas (o último vence). A restauração de backup passa pela mesma fila.
- Formulários validam dinheiro/quantidade (`src/domain/money.ts`) e arredondam para centavos.

**Testes:** +30 (`dataset`, `save-queue`, `order-cost`). Total após a fase: 241.

**Decisões**
- Valores em reais (float com arredondamento a centavos) foram mantidos; migrar tudo para centavos inteiros seria invasivo e sem ganho nesta etapa. Os valores são validados e arredondados nas bordas.
- Dados gravados no navegador **não** passam pela validação estrita (poderiam ser rejeitados e ficar ilegíveis); só backups e sincronização.
- O teste de backup "versão desconhecida" passou de `schemaVersion: 2` para `3` porque a versão 2 agora é válida (mudança legítima de contrato, não para esconder defeito).

**Riscos / pendências**
- Várias abas abertas ao mesmo tempo ainda podem sobrescrever uma à outra no IndexedDB (a fila protege apenas dentro de uma aba). Será tratado pelo controle de revisão da sincronização (Fase 3).

## Fase 2 — Autenticação e controle de sessões: CONCLUÍDA (backend; sem tela de login ainda)

**Feito** (detalhes em `worker/README.md`, seção "Contas e sessões")
- Login **sem senha** por código de 8 dígitos (HMAC no banco, uso único, 5 tentativas, 10 min). Conta só para e-mails com licença emitida.
- Sessão em cookie `HttpOnly`/`SameSite=Lax`/`Secure` (+ `__Host-` em https), token só como SHA-256 no banco, 30 dias, revogável.
- **CSRF**: origem autorizada + token por sessão.
- **Máximo de 2 dispositivos**, atômico; terceira instalação recusada (409) com opção de substituir; remoção de dispositivos; logout.
- Limites por e-mail/por código (principal) e por IP (rede ampla, nunca único bloqueio). Respostas que não revelam quais e-mails têm conta.
- Abstração de e-mail (`EmailSender`) com adaptador **dev** que não finge entrega; sem provedor o login responde 503.
- CLI: `issue --email`, `bind`, `revoke-sessions`; `revoke` agora encerra as sessões.
- Chave de licença antiga **desligada por padrão** (`LEGACY_KEY_AUTH=on` para reativar).
- Verificado também no Worker real (workerd + D1 local): login, CSRF, limite de dispositivos e substituição.

**Testes:** +47 (`worker-auth`). Testes antigos ajustados por mudança de contrato intencional: chave legada desligada por padrão e CORS com credenciais.

**Decisões:** login sem senha (evita armazenar senhas e simplifica recuperação); PBKDF2 limitado a 100 mil iterações no Workers foi um motivo adicional; conta só mediante licença (evita spam de e-mail e cadastro aberto); `Retry-After` e respostas genéricas.

**Pendências / riscos**
- **Decisão sua:** provedor de e-mail transacional (sem ele não há login em produção).
- O tempo de resposta de "pedir código" pode diferir entre e-mails com e sem conta (envio de e-mail); enumeração por tempo é possível, mitigada só pelo limite por e-mail.
- Limitar por e-mail permite negação de serviço do login de uma vítima (não afeta sessões abertas).
- `AUTH_SECRET` precisa ser definido como segredo no ambiente real (não versionado).
- A tela de login/dispositivos no app entra na Fase 3/4.

## Fase 3 — Persistência online: CONCLUÍDA (servidor + motor do cliente; ligação à interface na Fase 4)

**Feito** (detalhes em `worker/README.md`, seção "Dados online e sincronização")
- Tabelas D1 versionadas (`0004_data.sql`) com `user_id`, `rev` e exclusão lógica; ingredientes, receitas, itens de receita e encomendas.
- `GET /api/sync` (incremental por revisão) e `POST /api/sync/push` (transação única, atômico, até 100 alterações): conflitos por entidade (409), `STALE` em corrida, reenvio idempotente, integridade referencial (422), validação com as regras do backup, limites de tamanho e de taxa.
- **Isolamento por conta** verificado (mesmos ids em contas diferentes não interferem).
- Motor do cliente (`src/sync/engine.ts`): mesclagem de 3 vias, conflitos **preservados**, restauração de itens necessários, blocos em ordem de dependência, importação inicial com decisão do usuário, tolerância a falhas.
- Verificado no D1 **real** (workerd): envio atômico com `json_each`, conflito, integridade, idempotência, exclusão lógica e 401.

**Testes:** +53 (`sync-server` 24, `sync-engine` 29, incluindo dois dispositivos contra o Worker real com falhas de rede injetadas). Total: 341.

**Decisões**
- Servidor = fonte autoritativa; IndexedDB = cache + alterações pendentes.
- Conflito na mesma entidade: ~~servidor vence + cópia local preservada~~ **substituído na Etapa 2 (veja o fim deste documento): as duas versões ficam preservadas e o usuário decide.**
- Configurações (tamanho da xícara) sincronizam como uma entidade única.
- Entidade → linhas: itens de receita em tabela própria, gravados por `json_each` (um comando por receita, respeita o limite de parâmetros do D1).

**Pendências / riscos**
- A **interface** de login, dispositivos e "sincronizar" ainda não existe (entra na Fase 4 junto com os demais fluxos); o IndexedDB ainda não aciona a sincronização sozinho.
- Recebimentos (pagamentos) entram na sincronização na Fase 4 (extensão do esquema).
- `GET /api/sync?since=0` devolve tudo de uma vez (até ~5 mil itens); paginação fica para depois.
- A restauração automática de itens excluídos em outro dispositivo é uma escolha de segurança de dados; avaliar na prática se surpreende o usuário.
- Várias abas no mesmo navegador continuam podendo disputar o IndexedDB; a sincronização reconcilia pelo servidor.

## Fase 4 — Funcionalidades operacionais: CONCLUÍDA

**4a Recebimentos** (esquema v3): pagamentos parciais com data, meio opcional e observação; histórico, total recebido e saldo pendente; o total recebido (sinal + recebimentos) nunca passa do total da encomenda e o total não pode ser reduzido abaixo do recebido (sem crédito/reembolso). Validação no backup, tabela `order_payments` e sincronização.

**4b Agenda e prazo:** página Agenda (atrasados, hoje, próximos dias, adiante; status editável; saldo a receber). Tempo de produção por receita + capacidade diária e dias de trabalho nas Configurações geram a carga acumulada por entrega (folga/apertado/sobrecarga) e uma dica ao registrar a encomenda, **sempre rotulada como estimativa** ("não garante a entrega"); sem dados suficientes o resultado é "desconhecido" com o motivo, nunca um chute.

**4c Conta, sincronização e orçamentos por link na interface:**
- Painel da conta (login por código, troca de dispositivo, remoção, sair), painel de sincronização (estado, decisões, conflitos preservados) e lista de links publicados com revogação.
- Sincronização ligada ao app (`AccountProvider`): só roda com licença ativa, **nunca antes de carregar os dados locais**, em pausa após edições, ao voltar a internet e manualmente; bloqueia dados de outra conta no mesmo dispositivo até o usuário decidir.
- Orçamento por link: nome/telefone do negócio, prévia, aviso das limitações com confirmação, publicar, copiar (tratando falhas) e WhatsApp. `GET /api/quotes` lista os próprios links.
- Chave de licença antiga removida da interface (o modo continua no servidor, desligado por padrão).

**Verificações:** testes automatizados (390) e fluxo completo no navegador contra o Worker real: login por código → sincronização (dados no D1) → publicar → página pública sem dados internos e sem scripts → revogar (410).

**Defeitos encontrados e corrigidos nesta fase:** formulário de "Negócio" não recarregava quando as configurações vinham da sincronização (mostraria valores velhos e um "Salvar" sobrescreveria o servidor); reenvio após resposta perdida pedia decisão ao usuário sem necessidade (agora só pede se o servidor tiver algo diferente do local).

**Decisões**
- Recebimentos separados do sinal (`deposit` mantido) para não migrar dados nem quebrar fixtures.
- Análise de prazo propositalmente simples (carga acumulada vs capacidade), sem planejamento de produção.
- Mapeamento de links por encomenda não é guardado: a lista vem do servidor (fonte única).

**Pendências / riscos**
- Dois dispositivos registrando recebimentos no mesmo pedido ao mesmo tempo geram conflito (o servidor vence e o recebimento perdido fica guardado em "alterações substituídas"). Aceitável para beta; fusão por campo/lista é uma melhoria futura.
- Interface sem testes automatizados de componentes (ver Fase 5).

## Fase 5 — Experiência e qualidade: CONCLUÍDA

**Defeitos reais encontrados pelos novos testes de interface (e corrigidos)**
1. **Rótulos sem associação aos campos** em todo o app (`<label>` sem `htmlFor`): leitores de tela não anunciavam o nome dos campos e clicar no rótulo não focava o campo. Corrigido no componente `Field` (`useId` + `htmlFor`).
2. **Telas em branco em erros de regra de negócio:** regras que recusam uma operação (receber acima do saldo, editar encomenda, etc.) eram chamadas dentro da função de atualização do React, e o erro estourava durante a renderização, depois do `try/catch`. Agora o novo estado é calculado antes (`tryApply`), e a mensagem aparece normalmente. Foi acrescentada uma **rede de segurança** (`ErrorBoundary`) com mensagem útil e sem detalhes técnicos.
3. **Edição antes de carregar os dados:** a tela aceitava edições enquanto o IndexedDB ainda carregava (seriam sobrescritas). Agora mostra "Carregando seus dados…" e só libera os formulários depois.
4. A Agenda escondia, sem explicar, as encomendas novas (nascem como "Orçamento"). Agora há um aviso explicativo.

**Melhorias:** link "Pular para o conteúdo", `aria-current` na navegação, foco no título ao trocar de página, foco visível, status de sincronização no topo, texto do rodapé atualizado para a realidade com conta.

**Testes de interface (jsdom + Testing Library + fake-indexeddb): +19** — fluxo ingrediente → receita → preço → encomenda → recebimento → agenda (inclui custo histórico, recusa acima do saldo e persistência após recarregar), estados de carregamento e vazios, acessibilidade básica, login por código (código errado, troca de dispositivo, sair mantendo os dados), envio dos dados locais, modo offline e licença revogada. Total: 409.

**Layout móvel:** conferido em 390 px reais (iframe), sem rolagem horizontal em Encomendas, Agenda e Configurações.

**Playwright:** não foi adotado. Exige baixar navegadores e não há necessidade comprovada; os fluxos críticos estão cobertos por testes de componente com armazenamento real simulado, e o fluxo completo contra o Worker real foi verificado manualmente no Chrome. Reavaliar para testes e2e no CI se a equipe crescer.

**Pendências:** teste visual automatizado (capturas) e e2e em navegador real no CI; revisão de contraste das cores do Design System com ferramenta dedicada (cores preservadas conforme a regra).

## Fase 6 — Preparação para o beta: CONCLUÍDA (sem deploy)

**Feito**
- **GitHub Actions** (`.github/workflows/ci.yml`): build de tipos e produção (app + Worker), 409 testes, migrações do D1 num banco local temporário, auditoria de dependências (`npm audit --audit-level=high`) e verificação de segredos. Dependabot semanal (npm e Actions).
- A receita do CI foi **reproduzida a partir de um clone limpo** (`npm ci` → build → testes → migrações → auditoria → segredos): tudo passou.
- **Ambientes separados** em `worker/wrangler.toml` (`[env.staging]`, `[env.production]`) com marcadores no lugar dos IDs de banco, de modo que o deploy falha até serem preenchidos. Configuração validada com `wrangler deploy --dry-run` (sem publicar). Bundle do Worker: ~81 KiB (21,6 KiB comprimido).
- `scripts/check-secrets.sh` (testado com um segredo falso: detecta e falha) e `engines: node >=22.18` (o README dizia 20+, o que estava incorreto).
- **Documentação:** `docs/DESENVOLVIMENTO.md`, `AMBIENTES_E_VARIAVEIS.md`, `BACKUP_E_RECUPERACAO.md` (com **ensaio local** de exportar e restaurar em banco novo), `SEGURANCA_CHECKLIST.md` e `IMPLANTACAO_HOMOLOGACAO.md` (roteiro **não executado**).
- Tratamento de falhas de API: o cliente traduz 401/403/429/503/rede em mensagens claras; a sincronização interrompe sem perder dados; `ErrorBoundary` na interface.

**Pendências / riscos:** veja a seção seguinte.

---

# Resumo da Etapa 1 (estado final desta execução)

**Fases:** 1, 2, 3, 4, 5 e 6 concluídas no que é possível sem credenciais, custos ou ações em produção. Nada foi publicado, nenhum DNS foi alterado, nenhuma chave real foi criada e nenhum e-mail foi enviado.

**Números:** 24 arquivos de teste, **409 testes** passando; build de produção e checagem de tipos (app + Worker) sem erros; 0 vulnerabilidades conhecidas nas dependências; 6 migrações do D1.

## Pendências para produção
1. **Provedor de e-mail transacional** (decisão sua): sem ele não há login em produção.
2. Criar os bancos D1 reais, definir `AUTH_SECRET` por ambiente, configurar rotas/domínios/DNS e publicar (ações suas, com credenciais).
3. Regra de limitação de taxa por IP no WAF da Cloudflare para `/api/*`.
4. Hospedagem do frontend e seus cabeçalhos de segurança.
5. Retenção/limpeza de dados antigos, política de privacidade/LGPD e termos.
6. Rotina de backup do D1 e ensaio de restauração em homologação.
7. Monitoramento/alertas e revisão de segurança independente.
8. Fluxo comercial (cobrança, emissão automática de licenças, reembolso) — fora de escopo desta etapa.
9. Melhorias técnicas: paginação da sincronização completa, fusão por campo em conflitos, testes e2e em navegador real no CI, várias abas no mesmo navegador.

## Decisões que precisam da sua aprovação
- **Login sem senha por código no e-mail** (em vez de senha): é a arquitetura implementada.
- **Conflito na mesma entidade: o servidor vence e a versão local fica guardada** para o usuário refazer.
- **Conta só para quem tem licença emitida** (sem cadastro aberto).
- **Limites padrão por licença:** 100 links ativos, 30 novos links por dia, 20 escritas/min, 60 sincronizações/min; **até 2 dispositivos**.
- **Escolha do provedor de e-mail e da hospedagem** (custos).
- Manter ou remover o modo antigo de chave de licença no servidor (hoje desligado por padrão).

---

# Revisão do PR #1 (decisões aprovadas) — executada

Decisões aprovadas: login sem senha por código; contas só com licença ativa; 2 dispositivos; cotas 100/30; Cloudflare Pages + Workers + D1; **Resend** (plano gratuito); chave antiga desligada; servidor autoritativo com preservação e aviso. Nada foi publicado, nenhum DNS alterado, nenhum e-mail real enviado, nenhuma credencial real usada.

| # | Atividade | Resultado |
|---|---|---|
| 1 | Adaptador Resend | `createResendSender` (token só do segredo `RESEND_API_KEY`, `EMAIL_FROM` por variável validada, HTML responsivo + texto, limite de tempo de 8 s, 429 → `Retry-After`, erros genéricos sem chave/código/resposta). `dev` só com origens locais. Testes com `fetch` simulado (`tests/worker-email.test.ts`). |
| 2 | Acesso sem login | `VITE_REQUIRE_LOGIN=on` fecha a interface sem conta/licença, preserva e permite exportar os dados locais, tolerância offline de 7 dias. `docs/ACESSO_E_TRANSICAO.md`; `tests/ui/gate.test.tsx`. |
| 3 | Recebimentos concorrentes | Perda financeira vira pendência persistente (`ConflictRecord.financial`) com os valores; só sai por "Somar" (respeita o total) ou "Manter o servidor" (confirmação explícita). Encomenda excluída no outro aparelho pode ser recuperada como cópia. Aviso fixo em Encomendas e no topo; "Dispensar avisos" nunca remove pendência financeira. `tests/financial-reconcile.test.ts` (servidor real, dois dispositivos). |
| 4 | Revogação | Testado em todas as rotas protegidas (sync, orçamentos, licença), efeito imediato, reativação, novos logins, derrubada de sessões. O cliente detecta 403 e fecha o acesso. `tests/worker-lifecycle.test.ts`. |
| 5 | Sessões e limites | Renovação por uso (30 d de inatividade, teto 90 d); troca de dispositivo segura (código consumido antes de revogar); intervalo de 60 s entre envios; falha de envio descarta o código. |
| 6 | Hospedagem estática | `scripts/generate-headers.mjs` gera `dist/_headers` no build (CSP com `connect-src` = origem da API, HSTS, etc.); fontes passaram a ser locais (`@fontsource-variable`), sem Google Fonts. Verificado no Chrome real com os cabeçalhos aplicados: app carrega, fontes locais, zero violações. `tests/static-headers.test.ts`. |
| 7 | Verificações | Tipos (app e Worker) sem erros; **472 testes** (29 arquivos) passando; build; `npm audit` 0 vulnerabilidades; verificação de segredos; `wrangler deploy --dry-run --env staging` OK. |

## Riscos remanescentes
- O gate de login protege a interface, não os dados que já estão no navegador do próprio usuário (inerente ao local-first); a proteção real é o servidor.
- Negação de login temporária por quem conhece um e-mail (cota por e-mail): mitigar com WAF/Turnstile na rota de código.
- Remoção de recebimento feita aqui e ainda existente no servidor volta a valer (servidor vence), mas fica como pendência explícita; "somar" não repete a remoção — o usuário remove manualmente.
- Plano gratuito do Resend tem limites diários/mensais de envio: falha vira 503 com `Retry-After`; acompanhe o consumo.
- Tolerância offline é verificada no cliente (localStorage): serve para continuidade, não é controle de segurança.
- E-mail de teste real (entregabilidade, SPF/DKIM/spam) só pode ser validado em homologação.

## Correção: seleção explícita de ambiente nos CLIs de administração

Problema: `licenses.ts` usava sempre o banco `dabi-orcamentos` sem `--env`, então `--remote` não garantia o D1 de homologação.

- `worker/scripts/targets.ts`: fonte única dos ambientes (`local`, `staging`, `production`, `restore`) com banco e `--env` do Wrangler; `--remote` sozinho e combinações contraditórias são recusados; o destino é impresso antes de agir.
- `licenses` (`licensesCli.ts`) e o novo `npm run d1` (`d1Cli.ts`: migrate, export, restore-file, time-travel) usam essa tabela; `worker:migrate` agora é `d1 migrate --env local`.
- Produção: `revoke`, `revoke-sessions`, `migrate`, `restore-file`/`time-travel-restore` exigem confirmação extra (digitada, ou `--confirm-production <lic_id|nome-do-banco>` sem terminal); `restore-file` nunca vale para produção.
- Novo `[env.restore]` em `wrangler.toml` para ensaiar restauração sem tocar nos bancos reais.
- `tests/admin-cli.test.ts` (62 testes) valida os argumentos exatos passados ao Wrangler (com `exec` simulado, sem acessar banco algum), as recusas e a coerência com `wrangler.toml`/`package.json`.
- Exemplos corrigidos em README, `worker/README.md`, `DESENVOLVIMENTO`, `IMPLANTACAO_HOMOLOGACAO`, `BACKUP_E_RECUPERACAO` e `AMBIENTES_E_VARIAVEIS`. O restore antigo (`d1 execute dabi-orcamentos-restauracao` sem config) também estava incorreto: o banco não existia no `wrangler.toml`.

## Correção: login aceito, mas a tela de login continuava (homologação)

**Causa raiz (comprovada por teste):** app em `http://127.0.0.1:5174` e API em `*.workers.dev` são sites diferentes. O servidor aceitava o código e devolvia a sessão no corpo, mas o cookie `SameSite=Lax` não acompanhava as chamadas seguintes (fetch entre sites). Resultado: o app mostrava "Você entrou", a sincronização seguinte recebia 401 e o `AccountProvider` tratava isso como sessão encerrada, voltando ao login sem explicação. O servidor, o CORS e o CSRF estavam corretos; não houve alteração neles.

**Correção**
- `vite.config.ts`: proxy `/api` **só no `vite dev`** (`DEV_API_PROXY_TARGET`), com `VITE_API_URL=same-origin`; reescreve nome do cookie e `Secure` apenas na ida/volta local, sem tocar em `HttpOnly`, `SameSite`, `Origin` nem CSRF. Comando: `npm run dev:staging`.
- Login: depois do código aceito, o app confirma a sessão (`GET /api/auth/session`) **antes** de abrir o app e de avisar o sucesso; se o navegador não guardou o cookie, mostra o motivo.
- Sessão recusada na sincronização: volta ao login **com explicação** (sem toast falso, sem loop).
- Testes: `tests/ui/login-flow.test.tsx` (3 dos 5 falham no código antigo; cookie guardado/ não guardado/ perdido, recarregar a página, `same-origin`) e `tests/dev-proxy.test.ts`. Verificado também no Chrome contra o Worker local através do proxy (login, cookie HttpOnly invisível ao JavaScript, recarregar mantém a sessão, sincronizado).
- Produção: nada foi afrouxado. Aviso: app e API de homologação/produção precisam estar no mesmo site (domínios próprios do mesmo domínio registrável).

## Indicador de sincronização no cabeçalho

Os textos "Sincronizando…/Sincronizado" foram trocados por um ponto ao lado do e-mail (`src/account/syncIndicator.ts`). Ele mostra a **saúde**, não cada operação:

- **Verde**: há confirmação real do servidor (`lastSyncedAt`) e nenhuma alteração local pendente. Sincronizações normais não o tiram do verde.
- **Cinza**: sem confirmação ainda, offline, alterações a enviar ou falha recente. Só aparece depois de 6 s contínuos (ou imediatamente na primeira entrada, que nunca é verde).
- **Vermelho**: decisão pendente, recebimentos a reconciliar, atenção/licença, ou falha que persiste por 20 s.
- O tooltip (`title` e `aria-label`) traz o estado e o horário da última confirmação. Os avisos existentes (faixa de decisão, pendências financeiras) continuam iguais.
- Nenhuma lógica de sincronização, autenticação ou API foi alterada; o contexto só expõe `dirty`, derivado de dados já existentes.
- Testes: `tests/ui/sync-indicator.test.tsx`.

## Sincronização offline: reconexão, retry e indicador

**Causa raiz (sincronização).** Depois de uma falha de rede o app só voltava a sincronizar com o evento `online`, com uma nova edição ou ao reabrir. Ao alternar o DevTools de Offline para No throttling o navegador pode não emitir `online`; então o estado ficava em "offline" indefinidamente, com a alteração salva localmente (IndexedDB) mas nunca enviada. Também não havia sincronização ao voltar o foco para a janela (a outra sessão só recebia mudanças ao editar/recarregar), nem limite de tempo nas requisições (uma que nunca respondesse travava o ciclo), e a checagem de sessão ao abrir sem rede não era repetida. A API e as regras de autenticação/CSRF/conflitos não tinham defeito.

**Apresentação.** O cinza era correto (não havia confirmação), mas: (1) o "?" era o cursor `help` sobre um `title` nativo, que demora e não aparece em toque; (2) `dirty` comparava com a última versão aplicada, e por isso deixava de apontar a pendência depois de uma tentativa falha; (3) a última confirmação era apagada a cada falha.

**Correções.** Retry automático com espera 5 s → 10 s → 20 s… até 2 min (`src/sync/retry.ts`); nova tentativa ao voltar o foco/visibilidade (mín. 3 s em falha, 15 s normal) e `online`; tempo limite de 20 s por requisição; a checagem de sessão sem rede também é repetida; pendência real (`hasPending`) = diferença para a última versão confirmada pelo servidor; `lastSyncedAt` só muda com confirmação remota e `failingSince` marca a falha; indicador com rótulo visível quando não está verde e balão acessível (hover, foco, toque, Esc); falha de servidor com o navegador online vira vermelha se persistir. O aviso de salvamento ("Ingrediente atualizado…") continua dizendo só que foi salvo localmente.

Testes: `tests/ui/offline-sync.test.tsx`, `tests/sync-retry.test.ts`, `tests/ui/sync-indicator.test.tsx`.


## Etapa 2: conflitos de sincronização sem perda silenciosa

**Causa raiz.** A política anterior era "servidor vence + cópia local guardada": ao reconectar, `applyPull` aplicava a versão da nuvem nos dados locais (R$ 12 → R$ 13) e só deixava a versão local em `meta.conflicts`, visível apenas numa lista em Configurações (sem banner, sem comparação, sem forma de restaurar e com "Dispensar avisos"). Para quem usa o app, o valor local simplesmente desaparecia.

**Nova regra** (`src/sync/engine.ts`, `src/sync/resolve.ts`):
- Mesma entidade alterada aqui e na nuvem a partir da mesma base: **nada é aplicado nem enviado**. O conflito (`pending: true`) guarda `local`, `server` (+ `serverRev`) e `base`, é persistido no IndexedDB com o resto de `meta`, e a base/revisão da entidade não avançam. A versão local continua nos dados.
- O envio da entidade é retido (`buildPushes`), assim como o de quem depende de algo que a nuvem excluiu. As demais alterações sincronizam normalmente.
- Novos pulls/retries só **atualizam** a versão da nuvem do conflito (`serverRev`); nunca o eliminam. Se as duas versões ficarem iguais, ele se encerra como `identical` sem perda. `healConflicts` corrige o caso de queda entre gravar os dados e gravar o estado.
- Decisão: *manter minha alteração* (a versão da nuvem vira a base com a revisão dela; se a nuvem mudar de novo, o servidor recusa, o pull atualiza o conflito e pede nova decisão) ou *manter a da nuvem* (a versão local fica no histórico). Ambas exigem confirmação na interface. A escolha feita sobre uma comparação desatualizada é recusada.
- Encomendas: dinheiro mexido nos dois lados continua na reconciliação financeira explícita; ao manter a versão local de uma encomenda, recebimentos da nuvem nunca são descartados (união por id) e passar do total é recusado.
- Sem fusão automática por campo: só campos divergentes são mostrados. Fusão automática só seria segura onde os campos são independentes, o que não é demonstrável para custos derivados; na dúvida, o usuário decide.

**Interface.** `ConflictBanner` (App) derivado do estado persistido, `ConflictDialog` + `Modal` (comparação, confirmação, foco/Esc/"decidir depois"), `FinancialConflict` (extraído do painel de Configurações e reutilizado), indicador âmbar com a quantidade, painel de Configurações com os conflitos pendentes e o histórico. Conflitos de outra conta guardados no aparelho nunca aparecem.

Testes: `tests/conflict-resolution.test.ts` (motor + Worker real + IndexedDB), `tests/ui/conflicts.test.tsx`, `tests/sync-engine.test.ts`, `tests/ui/sync-indicator.test.tsx`.

## Etapa 3: catálogo de medidas e conversor

Catálogo local (~50 ingredientes, USDA FoodData Central em domínio público), busca segura por nome, referência adotada com valores congelados (`Ingredient.catalogRef`, valor informado pela pessoa tem prioridade), formulário de ingredientes simplificado com a área opcional "Medidas e equivalências", conversor reformulado (frações, exato × convencional × aproximado, ajuste temporário), aviso de impacto nas receitas e migração `0007_catalog_ref.sql` (preparada, **não aplicada**). Fontes, licenças, regras e limitações em `docs/CATALOGO_DE_MEDIDAS.md`.

## Etapa 3 (UX): cadastro de ingredientes simplificado

Formulário reduzido a nome, quantidade, unidade e preço + resumo compacto das medidas (`MeasuresSummary`); ajustes avançados sob demanda em diálogo com rascunho (`MeasuresDialog`, reaproveita `Modal`). Sem mudanças no catálogo, motor de conversão, preços, sincronização ou dados. Ingrediente novo com nome conhecido já grava a referência mostrada no resumo; editar nunca adota referência sozinho. Testes em `tests/ui/measures.test.tsx`.

## Etapa 3: código permanente do orçamento e pesquisa de pedidos

Código `ORC-XXXXXX` por pedido (gerado offline, único por conta, permanente), exibido no card, no orçamento público, no WhatsApp, no texto copiado e nos links publicados; busca expansível por código, cliente, produto e status. Migração `0008_quote_code.sql` preparada (não aplicada). Detalhes em `docs/CODIGO_DO_ORCAMENTO.md`.
