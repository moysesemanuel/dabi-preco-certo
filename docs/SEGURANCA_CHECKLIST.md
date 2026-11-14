# Checklist de segurança

Estado verificado em `feat/etapa-1-beta`. ✅ = implementado e testado; ⬜ = pendente (precisa de ação sua ou de decisão).

## Contas e sessões
- ✅ Sem senhas: login por código de 8 dígitos (HMAC com segredo do servidor, uso único, 5 tentativas, 10 min).
- ✅ Sessão em cookie `HttpOnly`, `SameSite=Lax`, `Secure` + prefixo `__Host-` em https; token guardado só como SHA-256.
- ✅ CSRF: origem autorizada + token por sessão em operações que alteram dados.
- ✅ No máximo 2 dispositivos (atômico); revogação de sessões e de licenças.
- ✅ Limites por e-mail e por código (defesa principal); por IP só como rede ampla; nunca bloqueio exclusivo por IP.
- ✅ Respostas não revelam quais e-mails têm conta.
- ✅ Adaptador Resend (testado com API simulada: 4xx/429/5xx, rede, tempo esgotado, sem vazar chave nem código). ⬜ Falta a chave real (`RESEND_API_KEY`) por ambiente.
- ✅ Sessão: 30 dias de inatividade, teto de 90 dias, renovação por uso, nunca reativa sessão revogada; troca de dispositivo consome o código antes de derrubar o outro; intervalo de 60 s entre envios.
- ✅ Revogação de licença bloqueia sync, orçamentos e verificação na próxima requisição (testado em todas as rotas); acesso comercial exige login (`ACESSO_E_TRANSICAO.md`).
- ✅ Conflito financeiro (recebimentos): nunca descartado; vira pendência que exige "somar" ou "manter o servidor" explícito.
- ⬜ Enumeração por tempo de resposta em "pedir código" (mitigada só pelo limite por e-mail).

## Dados
- ✅ Isolamento por `user_id` em todas as consultas (testado entre contas); consultas parametrizadas.
- ✅ Validação estrita de payloads (backup e sincronização); limites de tamanho e de quantidade.
- ✅ Exclusões lógicas; envio de sincronização atômico, com detecção de conflitos.
- ✅ Orçamento público sem custo, margem ou dados do cliente (campos desconhecidos são rejeitados).
- ⬜ Política de retenção/limpeza (orçamentos revogados, sessões expiradas, contadores) e revisão de LGPD (texto livre pode conter dados pessoais).
- ⬜ Paginação da leitura completa da sincronização (`since=0`) para contas muito grandes.

## Aplicação web
- ✅ Página pública sem JavaScript, com todo texto escapado; CSP sem scripts, `noindex`, `no-store`, `Referrer-Policy: no-referrer`.
- ✅ A API só aceita `https` (ou `http` em localhost) no app; chamadas com `credentials: include`, `no-store`, sem referrer.
- ✅ Nada de segredo em URL, log ou resposta (testes espionam o `console`).
- ✅ Cabeçalhos do **site do app** gerados no build (`dist/_headers`, Cloudflare Pages): CSP restritiva, HSTS, anti-iframe etc.; fontes locais. ⬜ Conferir em homologação com o domínio real.

## Operação
- ✅ Licenças emitidas só por CLI local (sem endpoint público); a chave de licença antiga está desligada por padrão.
- ✅ CI com testes, build, migrações, auditoria de dependências (0 vulnerabilidades hoje) e verificação de segredos.
- ⬜ Regra de limitação de taxa por IP no WAF da Cloudflare para `/api/*` (protege contra inundação sem licença).
- ⬜ `AUTH_SECRET` definido como segredo em cada ambiente; token da Cloudflare com escopo mínimo guardado fora do repositório.
- ⬜ Rotina de backup do D1 e ensaio de restauração em homologação (veja `BACKUP_E_RECUPERACAO.md`).
- ⬜ Registro de auditoria das emissões de licença (hoje só `created_at` e rótulo).
- ⬜ Monitoramento e alertas (erros 5xx, picos de 429) e plano de resposta a incidentes.
- ⬜ Revisão por pessoa independente antes de abrir ao público.
