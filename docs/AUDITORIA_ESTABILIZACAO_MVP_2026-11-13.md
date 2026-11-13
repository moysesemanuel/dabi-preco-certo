# Auditoria de estabilização do MVP — 13/11/2026

## Escopo e fotografia do código

Auditoria local do Custô na branch `feat/etapa-1-beta`. O HEAD-base desta análise era `1b152a3` (`feat: rebrand Custo and update application navigation`); as correções descritas abaixo são posteriores a esse commit e ainda precisam ser revisadas e publicadas. Não houve deploy, escrita remota, solicitação de código por e-mail, alteração de D1, DNS, secrets, licenças, administradores ou backups.

## Evidência remota somente de leitura

- O deployment mais recente listado no Pages `dabi-preco-certo-staging` é `a9efb520-07e2-428e-ac77-54d196a0ea01`, branch `staging`, source `88f85e8`.
- Esse source não é o HEAD `1b152a3`; portanto o staging não contém o commit local de rebranding nem as correções desta auditoria.
- Consultas GET em 13/11/2026: `/api/_edge/health` retornou HTTP 200, `ok=true`, `env=staging`, `binding=true`; `/api/auth/session` sem cookie retornou 401; `/admin` retornou 200; `/api/admin/me` sem cookie retornou 401.
- A listagem de deployments do Worker identificou `dabi-orcamentos-staging` ativo na versão `86fc9203-63f3-4b4a-8354-d4a12218352c` (deployment de 13/11/2026 02:14 UTC). Não foi feita comparação de código publicado byte a byte.
- `wrangler d1 info dabi-orcamentos-staging` registrou 15 tabelas, 225.280 bytes, 3.073 consultas de leitura e 670 de escrita, 7.965 linhas lidas e 1.023 escritas nas 24 horas da consulta. Esses números estão abaixo do pico histórico de 30.530 linhas escritas relatado anteriormente; a janela atual não explica aquele pico nem prova que não volte a ocorrer.

## Defeitos locais corrigidos

1. `readJsonBody` verificava o tamanho real somente depois de materializar todo o corpo com `request.text()`. Agora lê o stream incrementalmente, cancela a leitura ao exceder o limite e devolve 413. Há teste determinístico que confirma o cancelamento do stream.
2. O registro de recebimentos comparava o valor não arredondado com o saldo usando tolerância de meio centavo. Um valor como R$ 0,015 podia passar para um saldo de R$ 0,01 e ser contabilizado como R$ 0,02. Agora normaliza antes da comparação e armazena em centavos.
3. A edição de encomendas tinha a mesma tolerância para sinal e total recebido. Preço e sinal agora são normalizados antes das validações; recebimentos não podem exceder o novo total.
4. A validação estrita de backup/sincronização agora rejeita valores monetários sub-centavo, evitando que payloads externos introduzam valores que a interface apresenta arredondados mas calcula de forma divergente.

As regras de negócio permanecem: quantias digitadas são arredondadas para centavos e nunca há crédito ou reembolso automático.

## Segurança, autorização e dados

A revisão de código e a suíte existente cobrem código de uso único, expiração e tentativas, rate limits por e-mail/IP e globais, sessões, cookies `HttpOnly`/`Secure`/`SameSite=Lax` com prefixo `__Host-`, CSRF, revogação, licença ativa, autorização administrativa no servidor, isolamento entre contas e compartilhamento público revogável. Não foi identificado bypass nesses fluxos pela leitura local; essa conclusão não substitui teste de penetração independente.

A coordenação local usa Web Locks, BroadcastChannel e compare-and-swap no IndexedDB. A suíte exercita edição concorrente, troca de conta, resposta de push perdida, rebase durante sync, conflito, recuperação offline e idempotência. Os testes de custo confirmam zero chamadas durante aba ociosa simulada por até 24 horas. A observação positiva anterior do IP Pages → Service Binding → Worker é histórica; esta auditoria não repetiu tail nem gerou tráfego além dos GETs acima.

## Financeiro

As fórmulas de custo, margem, snapshots e orçamentos foram mantidas. Foram adicionadas regressões para precisão em centavos e prevenção de sobrepagamento. A suíte de custo usa SQLite local; não é uma medição de D1 nem previsão oficial. O modelo local mostra que, em hipóteses conservadoras próprias do projeto, escritas no D1 podem limitar o número de contas antes de leituras ou requisições; confira premissas antes de usar a projeção comercial.

## Marca e experiência

O Chrome local confirmou a tela de entrada em 320, 375, 390, 768, 1024 e 1440 px, sem overflow horizontal, com logo e ação de login visíveis e sem erros de JavaScript. Não foi feito login real, teste com teclado virtual em celular físico, teste com leitor de tela nem inspeção manual de todas as telas internas nesta revisão.

## Testes desta auditoria

- `npm test`: 950 aprovados, 2 ignorados (60 arquivos aprovados, 1 ignorado).
- `npm run costs`: 1 teste aprovado; gera perfil e projeções locais com hipóteses documentadas.
- Chrome + Playwright local: seis larguras aprovadas conforme acima.
- Typecheck, build, `npm audit --audit-level=high`, `scripts/check-secrets.sh`, `git diff --check`, dry-run de Pages e dry-run de Worker staging: aprovados. O dry-run do Worker mostra que o `EMAIL_FROM` no arquivo local protegido ainda usa o nome antigo DaBi Preço Certo; isso não prova o valor remoto. Corrigir essa identidade exige aprovação separada porque `worker/wrangler.toml` está protegido nesta auditoria.

## Limites gratuitos e observabilidade

A documentação atual informa que Pages Functions contam como requisições Workers no Free e que o total diário de Workers Free é compartilhado. As chamadas entre Workers via Service Binding são descritas sem tarifa adicional apenas no modelo Workers Standard; a aplicabilidade exata da contabilização de subrequisições para esta arquitetura sob Free precisa ser confirmada no Usage dashboard do plano ativo. D1 Free tem limites diários de linhas lidas/escritas; ultrapassar limite faz as consultas falharem até a próxima janela. Não use a projeção local como garantia de capacidade.

Referências oficiais consultadas em 13/11/2026:

- [Cloudflare Pages Functions — Pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [Cloudflare Workers — Pricing e Service Bindings](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare D1 — Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 — Limits](https://developers.cloudflare.com/d1/platform/limits/)

## Release e pendências

O script de publicação exige ambiente explícito e a publicação de produção exige `main`, checkout limpo, SHA completo aprovado e confirmação pelo nome do projeto. O caminho de staging não exige SHA aprovado nem checkout limpo; não usar para publicar esta revisão até preparar um commit revisado e inspecionar o diff. O staging publicado está atrasado em relação ao HEAD local. Antes de beta: revisar/commitar as correções, publicar staging sob autorização, repetir homologação funcional na revisão nova, acompanhar picos de Rows Written e Worker invocations no dashboard, confirmar política de backup/restauração e conferir contabilização Pages/Service Binding no plano efetivo.

## Veredito desta revisão

**NÃO APTO para produção ainda.** Os testes locais estão verdes após a correção, mas o staging não está na revisão local, as correções não foram publicadas, não houve homologação manual da revisão atual e a semântica de cota do Service Binding no Free ainda precisa ser confirmada no plano ativo. O código pode avançar para uma rodada controlada de beta fechado somente depois da revisão e publicação autorizada dessas mudanças no staging e nova homologação.
