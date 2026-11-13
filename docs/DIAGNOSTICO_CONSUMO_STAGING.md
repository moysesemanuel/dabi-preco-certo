# Diagnóstico de consumo do staging — 13/11/2026

Somente consultas de leitura à Cloudflare e testes locais foram feitos nesta investigação. Horários abaixo em UTC. Não foram emitidos códigos de login, criados dados, alterados recursos remotos ou executados deploys.

## Evidências remotas

As métricas vieram dos conjuntos GraphQL oficiais `workersInvocationsAdaptive`, `d1AnalyticsAdaptiveGroups`, `d1QueriesAdaptiveGroups` e `pagesFunctionsInvocationsAdaptiveGroups`, filtrados pela conta e pelo D1 de staging. Os insights SQL são agregados/amostrados; seus números não precisam coincidir exatamente com o total faturável do D1. Consultas D1 de `COUNT(*)` não mostraram dados pessoais.

| Intervalo UTC | Worker: requisições | D1: linhas escritas | D1: instruções de escrita | Pages Functions |
|---|---:|---:|---:|---:|
| 12/11, 13h–17h | 8.477 | 8.989 | 8.653 | 0 |
| 12/11, 18h | 3.164 | 15.767 | 7.353 | 0 |
| 12/11, 19h | 1.287 | 4.607 | 2.381 | 0 |
| 12/11, 20h | 22 | 52 | 33 | 0 |
| 13/11, 02h–12h observadas | 87 | 102 | 63 | 55 |

O Pages ainda não estava publicado durante os grandes picos: sua implantação canônica ocorreu em 13/11 às 02:43 UTC. A consulta específica de Pages retornou **55 invocações**, 44 subrequisições, zero erros de execução e `usageModel=standard` no período consultado. As invocações Pages e Worker são eventos distintos nas métricas; [a cobrança Standard do Service Binding](https://developers.cloudflare.com/workers/platform/pricing/) considera somente a requisição inicial e CPU somada, sem uma segunda requisição faturável.

Nas 24 horas anteriores ao diagnóstico inicial, `wrangler d1 insights` atribuiu aproximadamente 13.296 linhas escritas ao UPSERT de `rate_limits`, 5.994 a inserções de `order_payments`, 3.684 a UPSERTs de `orders`, 3.182 a exclusões de `order_payments` e 1.566 a atualizações de `sync_state`. Essas cinco famílias somam cerca de 27.722 linhas, próximas das 30.530 informadas pelo D1 na janela móvel, mas a janela e a amostragem variam. Às 18h UTC, os insights identificaram cerca de 4.704 linhas em inserções de recebimentos, 3.306 em UPSERTs de pedidos, 2.769 em contadores, 2.740 em exclusões de recebimentos e 1.111 em `sync_state`.

Uma consulta agregada ao banco encontrou **3 pedidos, 4 recebimentos, 2 estados de sincronização e revisão máxima 1.345**. Assim, o volume de UPSERTs de pedidos e de exclusão/reinserção de recebimentos não corresponde a milhares de novos pedidos; são regravações de um conjunto pequeno. A causa exata dos repetidos pushes às 18h–19h não é demonstrável pelas métricas disponíveis, que não incluem URL de rota nem ID de evento associado à consulta.

De 13h a 17h UTC, as cerca de 1,5–1,8 mil requisições por hora acompanharam quase uma instrução de contador por requisição e muitas leituras de sync. O repositório registra a correção do loop de pull a cada 2,5 segundos no commit `ad0a295`, às **19:40 UTC** de 12/11. O tráfego caiu para 22 requisições na hora seguinte. O teste `tests/ui/idle-sync.test.tsx` reproduz o loop antigo e confirma zero requisições por temporizador com o código atual. A associação é forte, mas a revisão exata executada pelo navegador durante cada hora não foi registrada remotamente.

Durante o pico de 18h–19h, a versão antiga do Worker teve 3.920 respostas HTTP 200, 13 respostas 429, 2 respostas 500 e uma 404; todas tiveram status de **invocação** `success`, que não significa HTTP 2xx. CPU P50 foi 6,154 ms e P99 13,475 ms para as respostas 200. A Cloudflare documenta tolerância ocasional acima de 10 ms sem erro `exceededCpu`; não houve tal erro no agregado consultado. Como o dataset não contém caminho de rota, o endpoint de maior CPU não foi identificado diretamente. Sync é a hipótese principal pela correlação de SQL, não uma atribuição medida de CPU.

## Rate limiting e IP

O Worker usa `CF-Connecting-IP` para os limites de login por IP, com fallback `unknown`; há também limites independentes por e-mail, código e teto global de e-mails. O D1 tinha quatro buckets IP para `login-request` e quatro para `login-verify`, sem valores brutos. Uma comparação **somente de leitura** entre os hashes do IP de egresso atual e de `unknown` não encontrou bucket correspondente; isso não demonstra o IP recebido pelo Worker no teste anterior, pois o egresso atual pode ser diferente do navegador e os buckets antigos podem ter sido limpos.

Quatro GETs sem cookie ao endpoint de sessão foram feitos: Worker direto, Pages e Pages com `X-Real-IP` de teste responderam 401; a requisição ao host Pages com `CF-Connecting-IP` forjado respondeu 403. O tail temporário não forneceu o valor de cabeçalho recebido pelo Worker, nem a camada que gerou o 403. Portanto, **a identificação do IP real através do Service Binding não está comprovada**. Não foi feito POST de login: ele escreveria contadores no D1, proibido nesta tarefa. A [documentação oficial](https://developers.cloudflare.com/fundamentals/reference/http-headers/) distingue subrequisições na mesma zona e entre zonas; não se deve inferir o resultado deste caminho sem medição.

Para fechar a pendência após autorização específica, adicionar temporariamente uma sonda que compare o IP visto pelo Pages ao visto pelo Worker e retorne apenas `present/match`, sem IP, hash persistente, cookie ou cabeçalhos completos. Fazer um único GET pelo operador e repetir com `X-Real-IP` de teste; retirar a sonda após validar. Não usar a guarda de ambiente como autenticação e não desligar limites.

## Consumo e release

O volume de 30.530 escritas não representa uso normal de oito testes manuais. A queda após a correção do loop e o baixo tráfego após o Pages são sinais favoráveis, mas os pushes repetidos merecem observação antes de clientes reais. A [política de custos](POLITICA_DE_CUSTOS.md) estima, por hipótese, 219 linhas escritas e 123 requisições por conta ativa/dia no perfil típico, ou 682 e 377 no pessimista. Com meta interna de 50% da cota gratuita e staging quieto, o gargalo estimado é D1: cerca de 228 contas típicas ou 73 pessimistas. Não são limites oficiais nem capacidade validada em produção. Começar com poucos clientes e revisar métricas diárias, inclusive Pages Functions, D1 e `exceededCpu`.

O script Pages rotulava qualquer checkout como branch `main` se recebesse apenas a confirmação do projeto. Foi corrigido para exigir `--approved-commit <SHA40>`, branch local `main`, `HEAD` igual ao SHA aprovado e checkout limpo **antes** do build ou upload. O deploy de Worker por comando Wrangler direto ainda depende de conferência humana da revisão; não há script de produção com a mesma guarda.
