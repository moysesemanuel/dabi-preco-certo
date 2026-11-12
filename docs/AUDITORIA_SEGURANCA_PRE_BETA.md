# Auditoria de segurança pré-beta (Etapa 4)

Escopo: código do app, do Worker e das migrações na branch `feat/etapa-1-beta`. Método: leitura do código de todas as rotas e acessos ao D1, mais testes **negativos** contra o Worker real com SQLite e as migrações reais, tudo local. Nenhuma requisição, ataque ou carga contra staging ou produção; nenhum deploy, migração remota, segredo ou `wrangler.toml` alterado; R1–R6 **não** implementados.

## Resumo

- **Nenhuma vulnerabilidade Crítica ou Alta comprovada.**
- **1 defeito comprovado (Médio), corrigido:** o logout confirmava "saiu" mesmo quando a chamada ao servidor falhava.
- 1 observação Informativa e 4 riscos residuais documentados abaixo (nenhum comprovado como exploração).
- Testes: 837 passam (803 existentes + 34 novos desta auditoria, mais 3 de logout), `tsc -b`, build e `npm audit` (0 vulnerabilidades) limpos.

## Achados

### F1 — Médio — Logout local sem confirmação do servidor (CORRIGIDO)
- **Onde:** `AccountContext.signOut` (`src/account/AccountContext.tsx`); chamadores em `AccountPanel`, `SyncPanel`, `AccessGate`.
- **Evidência:** `signOut` ignorava o resultado de `auth.logout`. Com a rede fora, a sessão continuava válida no servidor (cookie de 30–90 dias), mas a tela dizia "Você saiu desta conta" e voltava ao login.
- **Impacto:** a pessoa acha que encerrou a sessão (ex.: em aparelho emprestado) e não encerrou; a sessão ocupa uma das 2 vagas.
- **Condição:** falha de rede ou 5xx no momento do clique.
- **Correção:** `signOut()` devolve `{ ok } | { ok:false, message }`. Só limpa a sessão local e confirma após 200 ou 401 (401 = a sessão já não existe). Em falha, **continua conectado**, mostra "Você continua conectado: não foi possível confirmar a saída…" e permite tentar de novo.
- **Testes de regressão:** `tests/ui/account.test.tsx` ("Logout só é confirmado quando o servidor confirma": rede, 500, 401, e nova tentativa com sucesso).

### F2 — Informativo — Valores com frações de centavo são aceitos pelo servidor
- **Onde:** `shared/dataset.ts` (`isMoney`).
- **Evidência:** recebimento de 10,005 é aceito (400 não ocorre). O app arredonda ao digitar (`toCents2`) e os totais/validação "passa do total" arredondam a centavos.
- **Impacto:** nenhum comprovado; só um cliente adulterado enviaria isso, e o dano fica na própria conta.
- **Decisão:** não endurecer agora, para não rejeitar dados legítimos com ruído de ponto flutuante (ex.: 0,1+0,2) vindos de backups antigos. Reavaliar se surgir relatório divergente.

## Verificado e sem defeito (com teste)

Em `tests/security-audit.test.ts` (novo) e nos testes existentes (`worker-auth`, `worker-lifecycle`, `sync-server`, `worker`, `email-budget`, `multi-tab`, `coordination`, `storage-cas`):

- **Isolamento entre clientes:** o usuário vem sempre da sessão. Contra B usando ids de A: leitura desde a revisão 0 vazia; mesmos ids criam linhas próprias; exclusões e `baseRevs` forjados não alteram A; referenciar receita/ingrediente de A dá 422 com a **mesma resposta** de um id inexistente (sem enumeração); código ORC de A reutilizável por B sem pista e sem rota de consulta por código; configurações por conta; B não vê/encerra sessões de A; CSRF de uma conta não vale em outra.
- **Integridade financeira no servidor** (não só no front-end): recusa 400 para recebimento negativo/zero/texto/infinito, acima do total, sinal acima do total ou negativo, id de recebimento repetido, data inválida, >100 recebimentos, quantidade ≤0, preço negativo, custo registrado negativo, status inválido, id com SQL; número fora da faixa (1e999) recusado. Envios idênticos **simultâneos** e repetidos nunca duplicam recebimento. Alterar sinal/recebimentos não altera custo registrado nem código ORC.
- **API:** corpo gigante → 413; JSON inválido → 400 sem rastros internos; rotas protegidas sem sessão → 401; métodos não previstos recusados; origem não permitida → 403 sem cabeçalhos CORS; SQL/HTML em texto é gravado como texto (consultas parametrizadas).
- **Sessões/login (testes existentes):** código de 8 dígitos HMAC, validade 10 min, uso único, 5 tentativas, limites por e-mail/IP, cookie HttpOnly/SameSite=Lax/Secure (https, prefixo `__Host-`), CSRF por Origin + token em tempo constante, limite de 2 sessões atômico, revogação de dispositivo, renovação e expiração (ociosa 30 d / absoluta 90 d), token guardado como SHA-256.
- **Links públicos:** id de 128 bits, sem consulta por código ORC, 404 para inexistente, 410 para revogado, `no-store`, CSP `default-src 'none'`, escape de todo texto (teste de XSS existente em `tests/worker.test.ts`).
- **Multi-aba/persistência:** Web Locks para editor único, CAS por `dataVersion` no IndexedDB, BroadcastChannel, modo leitura, reverificação de sessão ao assumir edição, aviso de gravação obsoleta sem Web Locks.

## Riscos residuais (não comprovados como exploração)

1. **Cota diária de e-mail esgotável (Médio, operacional):** quem souber e-mails de clientes pode consumir o orçamento do dia e travar **novos** logins até 00:00 UTC (sessões atuais seguem). Mitigação definitiva = R3 (WAF/Turnstile, exige domínio). Plano de contingência: o suporte emite orientação e, se necessário, reduz `EMAIL_DAILY_LIMIT`/aguarda a virada do dia.
2. **Sem teto de registros/dia por conta no servidor (Médio, custo):** um cliente defeituoso pode gerar até 60 envios/min × 100 registros e esgotar as escritas do D1 no dia. Em beta fechado com contas licenciadas o risco é baixo; correção = R4/R5.
3. **Safari/iOS:** IndexedDB de sites **não instalados** pode ser limpo após ~7 dias sem uso (ITP). Os dados continuam no servidor para contas sincronizadas; recomendar instalar na tela inicial e manter backup `.json`. Web Locks e BroadcastChannel existem em Safari ≥15.4 e Firefox ≥96; sem Web Locks o app avisa e protege contra gravação obsoleta. **Não foi testado em navegadores reais nesta auditoria** (apenas jsdom e simulações): validar manualmente Safari, Firefox e Chrome antes do beta.
4. **Dependência do canal de e-mail:** o login depende da entrega do Resend (100/dia, 3.000/mês no plano gratuito); e-mails de teste reais não foram enviados nesta auditoria.

## Melhorias que exigem decisão (não implementadas)

R1–R6 permanecem como descritas em `docs/POLITICA_DE_CUSTOS.md` (limitador de leitura, push devolvendo revisões, domínio + WAF/Turnstile, teto de registros e teto diário por conta, cache curto de links públicos). Todas exigem decisão de arquitetura, domínio, migração remota ou serviço novo.

## Compatibilidade de navegadores

| Recurso | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Web Locks (editor único) | sim | ≥96 | ≥15.4 |
| BroadcastChannel | sim | sim | ≥15.4 |
| IndexedDB | sim | sim | sim, com limpeza após ~7 dias sem uso se não instalado |
| Cookie `__Host-` Secure HttpOnly | sim | sim | sim (exige https) |

Fonte: conhecimento de compatibilidade geral, não verificação em dispositivos nesta auditoria.

## Pendências obrigatórias antes do beta

1. Testar manualmente login, sincronização, duas abas e logout em Chrome, Firefox e Safari (desktop e iOS).
2. Confirmar entrega real do e-mail de código na homologação com o remetente definitivo.
3. Aplicar este código na homologação (decisão e execução do responsável; não feito aqui).
4. Definir o plano de contingência do orçamento de e-mail e acompanhar o consumo (`npm run costs`).

## Recomendação

**Apto para beta fechado com poucos clientes licenciados**, condicionado às pendências 1–3 acima. Não há falha comprovada de acesso entre clientes, perda de dados ou duplicação de recebimentos. Não é apto para abertura pública ampla enquanto R3, R4 e R5 não forem tratados.
