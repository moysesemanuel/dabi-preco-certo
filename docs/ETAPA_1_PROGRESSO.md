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
- Conflito na mesma entidade: **servidor vence + cópia local preservada** (em vez de "último a gravar vence" ou fusão por campo), por ser a opção que não perde dados e não exige adivinhar a intenção do usuário.
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
