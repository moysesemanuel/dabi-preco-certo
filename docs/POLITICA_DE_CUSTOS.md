# Política de infraestrutura de custo zero

> **Atualização da Etapa 7 (13/11/2026):** o Pages de staging usa `usage_model=standard`. A documentação atual da Cloudflare diz que Service Bindings no modelo Standard não geram requisição faturável adicional; a antiga hipótese de dobrar o consumo não deve ser usada como fato. Métricas de staging e lacunas de medição: [ETAPA_7_PREPARACAO_PRODUCAO.md](ETAPA_7_PREPARACAO_PRODUCAO.md).

**Diretriz:** manter o DaBi Preço Certo dentro dos limites **gratuitos** dos serviços, enquanto o volume de clientes permitir, **sem** limitar funcionalidades importantes nem comprometer a integridade dos dados. Vale para toda nova implementação (veja a lista de verificação no fim).

**Etapa 9 — embalagens:** o catálogo adiciona uma entidade sincronizada por conta; relações de embalagem da receita são gravadas junto à receita e snapshots adicionais junto à encomenda. Uma edição de catálogo/receita/pedido pode tocar mais linhas D1 que uma edição simples, em especial a substituição das relações da receita e pagamentos, mas as gravações continuam em lote (`db.batch`). Não há polling novo. Acompanhar no dashboard de staging Worker invocations/CPU e D1 rows written/read antes de ampliar o beta; os custos unitários subcentavo não causam consultas adicionais.

> Estimativas deste documento são **projeções com hipóteses explícitas**, nunca capacidade garantida. Os números oficiais vêm dos painéis dos provedores.

**Etapa 11 — encomendas com vários itens:** cada gravação de encomenda regrava suas linhas em `order_items` (DELETE + INSERT dos itens, no mesmo `db.batch`), e o pull faz +1 consulta para ler os itens das encomendas devolvidas. Nenhuma requisição nova e nenhum polling. Medição `npm run costs` (14/11/2026): o limite que manda continua sendo **escritas**, com ≈ 201 contas ativas no cenário típico e ≈ 64 no pessimista até 50% da cota (antes ≈ 228 e ≈ 73), pelas linhas de itens. Baixar a conta inteira passou de 12 para 13 consultas (limite gratuito: 50 por invocação). Encomendas antigas não geram escrita na migração 0012 (sem preenchimento retroativo).

## 1. Provedores e limites gratuitos

Verificado nas documentações oficiais em **12/11/2026** (a data de última atualização de cada página está na coluna "Fonte"). Limites mudam: reverifique antes de decisões de contratação e ao menos a cada trimestre.

| Serviço | Uso no projeto | Limite gratuito | Fonte |
|---|---|---|---|
| **Cloudflare Workers** (Free) | API, sincronização, páginas de orçamento | **100.000 requisições/dia** (zera 00:00 UTC; acima disso o erro 1027); **10 ms de CPU** por requisição; 50 subrequisições por invocação; 128 MB de memória | [Limits](https://developers.cloudflare.com/workers/platform/limits/) (29/10/2026), [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) (02/10/2026) |
| **Cloudflare D1** (Free) | Banco da conta, sessões, licenças, orçamentos | **5 milhões de linhas lidas/dia**; **100.000 linhas escritas/dia** (índices contam: +1 linha por índice tocado); **5 GB** no total e **500 MB por banco**; **50 consultas por invocação** (um `db.batch()` conta como 1); no máx. 100 parâmetros por consulta; Time Travel de 7 dias | [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) (30/10/2026), [Limits](https://developers.cloudflare.com/d1/platform/limits/) (30/10/2026) |
| **Cloudflare Pages** | App estático (sem Functions) | 500 builds/mês, 20.000 arquivos/site, 100 domínios personalizados por projeto; arquivos estáticos não consomem a cota de requisições do Worker ("static assets: free and unlimited") | [Limits](https://developers.cloudflare.com/pages/platform/limits/) (05/09/2026) |
| **Workers Logs / métricas** | Observabilidade nativa | Logs: 200.000 eventos/dia, retenção de 3 dias; métricas dos Workers por até 3 meses | [Pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) |
| **Cloudflare WAF** (Free, exige domínio na zona) | Proteção do endpoint público | 5 regras personalizadas; **1 regra de rate limiting** (contagem por IP, período de 10 s) | [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/), [Custom rules](https://developers.cloudflare.com/waf/custom-rules/) |
| **Resend** (Free) | E-mail do código de acesso | **100 e-mails/dia** (dia UTC) e **3.000/mês**; 3 domínios; **10 requisições/s por equipe**; envios e recebimentos contam; destinatários múltiplos contam separados; o excedente retorna 429 e **não é reenviado**; retenção de 30 dias | [Cotas e limites](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [Rate limit](https://resend.com/docs/api-reference/rate-limit), [Preços](https://resend.com/pricing) |

Pontos de atenção que vêm da documentação:
- **Escrita no D1 é o limite mais apertado** (100 mil/dia contra 5 milhões de leituras): ~50x menor.
- O erro 1027 e o comportamento "fail open/closed" da rota: com domínio próprio, escolha **fail closed** para a rota da API (Workers → Routes), para que estouro de cota não contorne o Worker.
- Pages Functions contam nas requisições do Worker: mantê-las apenas em `/api/*` e `/o/*`; o app estático não as invoca.
- Consultas manuais (dashboard, `wrangler`, exportações) também consomem leituras do D1.

## 2. Metas internas (conservadoras)

Planejar até **50%** de cada limite gratuito (folga para picos, retries, erros e crescimento). **Alerta** em 60%, **ação** em 80%.

| Métrica diária | Limite gratuito | Meta (50%) | Alerta (60%) | Ação (80%) |
|---|---|---|---|---|
| Requisições do Worker | 100.000 | 50.000 | 60.000 | 80.000 |
| Linhas escritas no D1 | 100.000 | 50.000 | 60.000 | 80.000 |
| Linhas lidas no D1 | 5.000.000 | 2.500.000 | 3.000.000 | 4.000.000 |
| E-mails do Resend | 100 (3.000/mês) | 50 (1.500/mês) | 60 (1.800/mês) | 80 (2.400/mês) |
| Armazenamento D1 (banco) | 500 MB | 250 MB | 300 MB | 400 MB |
| Consultas D1 por requisição | 50 | 25 | — | — |

Limites do próprio Worker (para travar abuso e proteger a cota): login 5 códigos/hora e **12/dia por e-mail**, **80 e-mails/dia no total** (`EMAIL_DAILY_LIMIT`, abaixo dos 100 do Resend), 15 confirmações/hora por e-mail, 100 links ativos e 30 por dia por licença, 60 requisições de sincronização/min por conta, 100 alterações e 1 MB por envio, 16 KB por orçamento.

## 3. Auditoria do consumo atual (medida)

Metodologia reproduzível: `npm run costs` (veja a seção 7). Mede cada ação típica do app contra o **Worker real e o SQLite real** (com as migrações reais), contando requisições, consultas D1 e **estimativa** de linhas lidas/escritas (a contagem oficial só existe no D1 real; aqui, escritas = alterações × (1 + índices), um limite superior). Conta com 60 registros (30 ingredientes, 10 receitas, 20 pedidos):

| Ação | Requisições | Consultas D1 | Linhas lidas ≈ | Linhas escritas ≈ |
|---|---|---|---|---|
| Login (pedir código + confirmar) | 2 | 27 | 27 | 18 |
| Abrir o app já logado (sessão) | 1 | 3 | 3 | 0 |
| Primeira sincronização (60 registros) | 3 | 33 | 252 | 239 |
| Sincronização **sem mudanças** (abrir/voltar o foco) | 1 | 8 | 8 | **1** |
| Editar 1 registro e sincronizar (pull + push + pull) | **3** | 23 | 24 | 6 |
| Registrar recebimento e sincronizar | 3 | 27 | 30 | 10 |
| Outro aparelho baixa a conta inteira | 1 | 10 | 103 | 1 |
| Outro aparelho recebe 1 mudança | 1 | 8 | 8 | 1 |
| Publicar / revogar link | 1 | 6 | 6 | 4 |
| Cliente abre o link público | 1 | **1** | 1 | 0 |

Nenhuma requisição passa de 10 consultas D1 (limite gratuito: 50) e nenhuma consulta quente varre tabela inteira (teste de regressão).

### Gargalos concretos encontrados

1. **Escrita no D1 é o gargalo da capacidade.** Cada requisição autenticada grava 1 linha só para o contador de limite de taxa (`rate_limits`): ~55% das escritas de uma conta típica são contadores, não dados. Uma sincronização sem mudanças tem 1 escrita, 100% contador.
2. **Edição = 3 requisições.** O ciclo é pull → push → pull; o último pull só serve para fixar as revisões das entidades enviadas (ver recomendação R2).
3. **(Corrigido)** Cada envio lia **todos** os ids ativos de ingredientes e receitas da conta (`activeIds`) só para validar referências: o custo crescia com o tamanho da conta (editar 1 registro lia 1.029 linhas com 1.500 registros, contra 64 com 60). Agora só os ids referenciados são consultados; o custo não depende do tamanho da conta (teste `tests/costs/scaling.test.ts`).
4. **(Corrigido)** A limpeza de contadores apagava também as janelas de **outros escopos** da mesma chave, o que zerava limites de janela maior (o teto diário por e-mail simplesmente não funcionava). Agora limpa só o mesmo escopo.
5. **(Corrigido, risco real)** O limite de login (5 pedidos/hora por e-mail) permitia **120 e-mails/dia para um único cliente**, e ~21 e-mails de clientes bastavam para esgotar a cota de 100/dia do Resend e travar novos logins de todos. Agora: teto de 12/dia por e-mail e orçamento global de 80/dia, com a resposta "limite do dia" igual para qualquer e-mail (não revela quem é cliente).
6. **Sem teto de registros por conta no servidor.** Só existem o teto por envio (100 alterações) e por corpo (1 MB); os tetos de 5.000/5.000/20.000 valem apenas para backup. Uma conta (ou cliente defeituoso) pode gerar até 60 envios/min × 100 registros e esgotar as escritas do dia. **Exige migração: ver R4.**
7. **Limite de sincronização muito frouxo para proteger a cota diária:** 60/min por conta = 86.400/dia, quase toda a cota do Worker. Serve contra rajadas, não contra consumo contínuo (ver R1/R5).
8. **Link público sem limite de taxa:** cada abertura custa 1 requisição e 1 leitura (barato), mas um link muito divulgado ou alvo de varredura consome a cota diária compartilhada. Sem WAF/limitação no provedor (só com domínio próprio) não há como limitar por IP dentro do Worker sem gastar escrita no D1.

### Achado da homologação: pulls a cada 2,5 s (corrigido)

No `wrangler tail` apareceu `GET /api/sync?since=N` repetido a cada ~2 s com a aba ociosa. Causa comprovada (reprodução em `tests/ui/idle-sync.test.tsx`): a sincronização guardava "o último resultado" numa única referência (`lastApplied`) escrita **dentro** da função de atualização do estado. Em desenvolvimento (React **StrictMode**, usado por `npm run dev` e `dev:staging`) essa função roda duas vezes e a referência passava a apontar para um objeto diferente do estado; o efeito de "edição local" (pausa de 2,5 s) via a diferença e agendava uma nova sincronização, para sempre (cada ciclo era só um pull; nada mudava). Acontecia depois de qualquer ciclo que alterasse dados locais (ex.: preencher códigos de pedidos antigos). Em produção (sem StrictMode) o laço não ocorria, mas a referência era frágil do mesmo jeito. Correção: um `WeakSet` marca os objetos produzidos pelo próprio app (independe de quantas vezes o React chama a função), e os dados lidos do disco também não disparam a pausa de edição. Consumo de uma aba ociosa: **antes (dev)** ≈ 34.560 pulls/24 h; **depois** 0 por temporizador (só 1 verificação por retorno de foco, no mínimo 15 s entre elas). Não há polling periódico; uma aba que fica visível sem interação não recebe mudanças de outro aparelho até ganhar o foco (decisão consciente: um polling de 5 min custaria ≈ 288 requisições/dia por aba, mais que todo o uso típico de uma conta).

### O que já é eficiente (sem mudança necessária)
- **Sem polling:** nenhum `setInterval`; a sincronização ocorre ao abrir, ao editar (com pausa de 2,5 s), ao voltar o foco (mínimo 15 s) e ao reconectar.
- **Pull incremental:** a sincronização sem mudanças custa o mesmo com 60 ou 1.500 registros (só devolve o que mudou, por índice `(user_id, rev)`).
- **Falhas:** retry com backoff 5 s → 5 min (era 2 min) e sem requisições enquanto o navegador está offline.
- **Sessões persistentes:** 30 dias de inatividade (até 90 dias) tornam o login por e-mail raro (~0,03 login/conta/dia na hipótese típica).
- **Lote:** o envio grava tudo em **um** `db.batch()` (1 consulta para o limite de 50 por invocação).

## 4. Projeção por conta ativa (hipóteses explícitas)

Hipóteses por conta e por dia (**suposições**, ajuste com dados reais da homologação; arquivo `tests/costs/model.ts`):

| | Típico | Pessimista |
|---|---|---|
| Aberturas do app | 4 | 8 |
| Sincronizações ao voltar o foco | 20 | 60 |
| Rajadas de edição sincronizadas | 25 | 80 |
| Links publicados | 2 | 5 |
| Visitas a Configurações | 3 | 8 |
| Aberturas de links públicos por clientes | 12 | 40 |
| Logins por e-mail | 0,03 | 0,1 |

Resultado medido + hipóteses (**estimativa**, aceitando a incerteza da contagem local de escritas):

| Por conta ativa/dia | Requisições | Leituras ≈ | Escritas ≈ | E-mails |
|---|---|---|---|---|
| Típico | 123 | 910 | 219 | 0,04 |
| Pessimista | 377 | 2.801 | 682 | 0,20 |

| Contas ativas | Req./dia (típico → % de 100 mil) | Escritas/dia (típico → % de 100 mil) | Escritas/dia (pessimista → %) |
|---|---|---|---|
| 10 | 1.231 (1,2%) | 2.185 (2,2%) | 6.818 (6,8%) |
| 50 | 6.153 (6,2%) | 10.927 (10,9%) | 34.090 (34,1%) |
| 100 | 12.306 (12,3%) | 21.854 (21,9%) | 68.180 (68,2%) |
| 500 | 61.530 (61,5%) | **109.270 (109,3%)** | **340.900 (340,9%)** |

Contas ativas até a meta de 50%: **≈ 201** (típico) e **≈ 64** (pessimista) desde a Etapa 11 (eram ≈ 228 e ≈ 73), limitadas por **escritas no D1**; depois, requisições (≈ 406 / 132). Leituras (≈ 2.700 / 890 contas) e Resend (≈ 1.100 / 250 contas) não são gargalo. Armazenamento: ≈ 14 KiB por conta típica (≈ 250 B/registro) → milhares de contas dentro de 250 MB.

**Leitura honesta:** 10, 50 e 100 contas ativas cabem com folga em qualquer cenário; **500 contas ativas não cabem** no plano gratuito (escritas). Planeje a migração de plano ao passar de ~200 contas ativas por dia ou quando o monitoramento acusar 60% (seção 8).

## 5. Princípios de eficiência (para toda nova implementação)

1. **Sem polling de alta frequência.** Sincronizar por evento (abrir, editar, foco, reconexão). Qualquer intervalo periódico novo precisa de justificativa e de cálculo de custo.
2. **Não sincronizar sem necessidade.** Nada de "sincronizar agora" automático além dos gatilhos existentes; respeitar os intervalos mínimos (`src/sync/retry.ts`).
3. **Operações do servidor com custo independente do tamanho da conta.** Sem `SELECT` de listas inteiras, sem `COUNT(*)` por requisição em tabelas grandes; use chave primária, `IN (json_each)` ou índice `(user_id, rev)`. O teste `scaling.test.ts` protege isso.
4. **Índices só com benefício demonstrável**: cada índice acrescenta 1 linha escrita por gravação. Meça com `npm run costs` antes e depois.
5. **Sem gravações redundantes.** Reenvios idênticos devem ser no-op (já é o caso); não regravar o que não mudou.
6. **Retry com backoff e teto** (5 s → 5 min); nunca laço apertado; respeitar `Retry-After`.
7. **Cache só quando seguro.** Nunca cache compartilhado de dados privados. O app já guarda tudo no IndexedDB. Para páginas públicas de orçamento, cache em borda só com TTL curto e aceitando que a revogação demora até o TTL (decisão de produto; ver R6).
8. **Cálculos locais.** Catálogo de medidas, conversões e custos rodam no aparelho, sem API externa.
9. **Sessões longas** (já 30/90 dias) para reduzir e-mails de código; mensagens de erro de login sem convite a "tentar de novo" em laço.
10. **Limites no servidor**, nunca só no front-end, e proporcionais ao uso normal.
11. **Toda função nova que fale com o Worker** declara no PR: requisições por uso típico, consultas D1, linhas escritas e o efeito no teto de 25 consultas/requisição; rode `npm run costs`.

## 6. E-mails (Resend)

- Só e-mails com **licença ativa** recebem código (sem licença: mesma resposta, nenhum envio): quem não é cliente não gasta cota.
- Limites em camadas: intervalo mínimo de 60 s por e-mail, 5/hora e **12/dia por e-mail**, 30/hora por IP, e **orçamento global de 80/dia** (`EMAIL_DAILY_LIMIT`, configurável ao mudar de plano). Ao esgotar, o Worker devolve `503 EMAIL_DAILY_BUDGET` com `Retry-After` até 00:00 UTC, **sem chamar o Resend**, e a resposta é igual para qualquer e-mail (não revela clientes).
- A cota do Resend zera à meia-noite **UTC** (21h no horário de Brasília); o orçamento do Worker usa a mesma janela.
- Falha de envio descarta o código (não fica código válido que ninguém recebeu). Um código enviado vale por 10 min e aceita 5 tentativas: **não** reenviar automaticamente.
- Não usar o Resend para nada além do código de acesso sem recalcular a cota (cada destinatário conta 1). Sem e-mails de marketing, boas-vindas ou avisos em massa na faixa gratuita.
- Monitorar: página de uso do Resend e os cabeçalhos `x-resend-daily-quota` / `x-resend-monthly-quota` (só no plano gratuito). A tabela `rate_limits` mostra o consumo do orçamento do Worker (consulta na seção 8).
- Risco residual: quem conhece e-mails de clientes pode consumir o orçamento do dia (12 por e-mail), travando **novos** logins até a meia-noite UTC (sessões existentes seguem). Mitigação: regra de rate limiting/Turnstile na rota `request-code` quando houver domínio na zona (R3).

## 7. Medição e estimativa reproduzíveis

```bash
npm run costs      # perfil medido + projeção para 10/50/100/500 contas (hipóteses típica e pessimista)
npx vitest run tests/costs   # orçamentos de regressão (rodam também em `npm test`)
```

- `tests/costs/profile.ts`: executa as ações reais (login, sincronização, publicação, link público) contra o Worker e o SQLite de teste com o medidor `tests/helpers/costMeter.ts`.
- `tests/costs/model.ts`: **limites oficiais**, hipóteses de uso e as contas. Mudou um limite no provedor? Atualize aqui e na seção 1.
- `tests/costs/budgets.test.ts` e `scaling.test.ts`: falham se uma mudança aumentar o consumo (consultas por requisição, varreduras, escritas por ação, dependência do tamanho da conta).
- **Limitações:** a contagem de linhas é estimada localmente (SQLite, não D1); o uso real depende do comportamento das pessoas; picos e retries não estão no modelo. **Não** execute testes de carga contra a Cloudflare de homologação sem autorização: cada requisição consome a cota diária real.

## 8. Monitoramento e alertas (só recursos gratuitos)

| O que | Onde | Frequência |
|---|---|---|
| Requisições, erros, tempo de CPU do Worker | Cloudflare → Workers & Pages → (Worker) → Metrics (retenção de até 3 meses); API GraphQL de métricas | Semanal; diário se > 40% |
| Linhas lidas/escritas e armazenamento do D1 | Cloudflare → D1 → (banco) → Metrics → Row Metrics; GraphQL do D1 | Semanal; diário se > 40% |
| E-mails diários/mensais do Resend | Resend → Usage; cabeçalhos `x-resend-*-quota` | Semanal |
| Erros e eventos | Workers Logs (gratuito: 200 mil eventos/dia, 3 dias): ativar `observability` em `wrangler.toml` **só na homologação/produção e com amostragem** (não alterado nesta tarefa) | Sob demanda |
| Uso por conta | Ver limitações abaixo | Mensal |

**Alertas:** verifique nos painéis da Cloudflare e do Resend se há notificações de uso disponíveis para o seu plano (**não verificado nesta tarefa**) e, se houver, configure-as em 60%. Não dependa delas: mantenha uma **rotina manual semanal** de 5 minutos olhando as quatro métricas acima contra a tabela de metas (seção 2). Registre os números no `ETAPA_1_PROGRESSO.md` ou numa planilha.

**Limitações:** os provedores **não** informam consumo por cliente. Aproximações baratas (consultas somente-leitura, rodar com moderação porque também consomem leituras): quantos registros e sincronizações cada conta tem (`sync_state.revision` indica o total de envios aceitos), quantos links (`quotes`) e quantos e-mails do dia (`SELECT count FROM rate_limits WHERE license_id='global' AND scope='email-send-day'`). Se precisar de consumo por conta de forma contínua, isso exigiria contadores próprios (mais escritas): só vale se um cliente específico for suspeito de abuso.

## 9. Proteções contra abuso (revisão)

| Superfície | Proteção atual | Lacuna / decisão |
|---|---|---|
| Pedir código | 5/h e **12/dia por e-mail**; 30/h por IP; intervalo de 60 s; **80/dia no total**; só e-mail com licença envia | Rotação de IPs contorna o limite por IP: aceitável porque o limite por e-mail e o global não dependem de IP |
| Confirmar código | 15/h por e-mail, 60/h por IP; 5 tentativas por código; código de 8 dígitos, 10 min, uso único | Suficiente |
| Publicar links | 100 ativos, 30/dia por licença; 20 escritas/min; corpo ≤ 16 KB; validação estrita | Suficiente |
| Ver link público | Nenhuma (id de 128 bits; 1 leitura por abertura) | R3/R6: regra de rate limiting no domínio + cache curto |
| Sincronização | 60/min por conta; 100 alterações e 1 MB por envio; CSRF; licença ativa | **Faltam teto diário por conta e teto de registros por conta** (R4/R5) |
| Rotas desconhecidas | Resposta 404 simples; sem consulta ao D1 | Custam 1 requisição de Worker: só o WAF do domínio limita |
| Front-end | Backoff, intervalos mínimos, sem polling | Não é proteção (o servidor não depende dele) |

## 10. Melhorias realizadas nesta etapa

- Orçamento diário de e-mails (global, 80/dia) e teto de 12/dia por e-mail, com testes.
- Correção do apagamento de contadores de outros escopos.
- Validação de referências no envio sem ler todos os ids da conta (custo independente do tamanho).
- Uma consulta a menos por requisição de sincronização (`getState`).
- Retry máximo de 2 min → 5 min (≈ 60% menos tentativas em indisponibilidades longas).
- Medidor de consumo, modelo de projeção e orçamentos de regressão (`npm run costs`).

## 11. Melhorias recomendadas (exigem sua aprovação: impacto estrutural)

| # | Proposta | Ganho estimado (medido/modelado) | Risco / custo |
|---|---|---|---|
| **R1** | Pulls (leitura) sem contador no D1: limitá-los só por um limitador em memória por isolado (melhor esforço) ou pelo binding gratuito de rate limit, mantendo o contador D1 apenas nas operações que gravam | Corta ≈ 55% das escritas: capacidade típica de ≈ 228 para ≈ 450 contas (meta 50%) | Mexe na segurança do limitador; o binding `ratelimits` existe, mas **sua disponibilidade no plano gratuito não foi verificada** nesta tarefa. Requer análise e testes de abuso |
| **R2** | O `push` devolver as entidades gravadas com suas revisões, e o app pular o pull de confirmação quando `revisão == base + 1` | −1 requisição de 3 por edição (−33% de requisições de edição) e −8 consultas | Mexe no protocolo e no motor de sincronização (versões de app/Worker em coexistência) |
| **R3** | Domínio próprio na zona + regra WAF de rate limiting (1 regra gratuita, por IP, 10 s) para `/api/auth/request-code` e `/o/*`; Turnstile no pedido de código | Protege Resend e cota do Worker contra abuso externo | Depende de domínio; Turnstile é um serviço novo (**plano e termos não verificados**; avaliar privacidade) |
| **R4** | Teto de registros por conta no servidor (contador em `sync_state`, migração + preenchimento inicial) | Evita que uma conta esgote as escritas do dia | Migração remota (preparar e documentar, não executar) |
| **R5** | Teto diário de sincronização por conta (ex.: 5.000 requisições) | Limita o dano de um cliente defeituoso | +1 escrita por requisição se feito em D1 → só junto com R1 |
| **R6** | Cache curto (60 s) nas páginas públicas de orçamento na borda (domínio na zona) | Corta requisições de links muito acessados | A revogação demora até o TTL: decisão de produto |

### Painel administrativo (Etapa 5)
Rotas `/api/admin/*`: autorização no servidor, 120 leituras e 30 escritas por minuto por administrador, paginação por cursor (25 por página), uma consulta agregada para os indicadores, auditoria com retenção de 365 dias. Sem polling e sem serviço novo; uso esperado de dezenas de ações por dia (desprezível frente aos limites). Detalhes em `PAINEL_ADMINISTRATIVO.md` §9.

### Publicação no Pages (Etapa 6)
Cada chamada `/api/*` e `/o/*` passa por uma Pages Function e pelo Worker via Service Binding. O Pages usa o modelo Standard: a [documentação de preços dos Workers](https://developers.cloudflare.com/workers/platform/pricing/) diz que a chamada ao serviço vinculado não acrescenta requisição faturável nesse modelo; modelos legados Bundled/Unbound diferem. A Function conta na cota Workers Free, e arquivos estáticos não contam. A projeção antiga de 2 requisições por ação (≈132 → ≈66 contas a 50%) era uma hipótese conservadora, não um limite confirmado. Validar o uso faturável real no painel.

## 12. Critérios para considerar upgrade

Considerar quando **qualquer** um ocorrer (Workers Paid: assinatura mínima de US$ 5/mês por conta, mais uso acima do incluído):
- escritas do D1 ≥ 60% do limite diário (**60 mil**) em 3 dias seguidos, ou projeção de ultrapassar 80% nos próximos 30 dias;
- requisições do Worker ≥ 60 mil/dia (erro 1027 ameaça o login e a sincronização de todos);
- e-mails do Resend ≥ 60/dia ou ≥ 1.800/mês de forma recorrente (próximo passo: Resend Pro, US$ 20/mês, sem limite diário);
- banco D1 ≥ 300 MB (limite de 500 MB por banco no gratuito);
- erros 1027/`daily quota` ou falhas de D1 por limite diário registradas **uma vez** em dia útil;
- a receita recorrente por conta cobrir o custo do plano pago com margem.

A contratação é decisão sua (envolve custo e dados de pagamento). Antes, aplique R1/R2 se ainda estiverem pendentes: dobram a capacidade sem custo.

## 13. Lista de verificação para novas funcionalidades

- [ ] Quantas requisições ao Worker por uso típico? (evite aumentar; reutilize as existentes)
- [ ] Quantas consultas D1, linhas lidas e **escritas**? Depende do tamanho da conta? (não deve)
- [ ] Há polling, laço ou retry sem teto? (não pode)
- [ ] O limite é imposto no servidor? Qual o pior caso de uma conta abusiva?
- [ ] Envia e-mail? Qual o impacto no orçamento diário do Resend?
- [ ] Rodou `npm run costs` e os orçamentos continuam passando?
- [ ] Atualizou esta política se limites, metas ou hipóteses mudaram?
