# Diagnóstico: "Falha ao sincronizar" após a Etapa 11 (14/11/2026)

## Causa raiz (comprovada)

**Assimetria de representação:**
- O app guardava `packagingItems: []` nas encomendas **sem** embalagens adicionais (cadastro e edição).
- O Worker grava a lista vazia como `'[]'` e, ao devolver a encomenda, **omite** o campo (`worker/src/sync.ts`, `orderOf`).
- A comparação (`sameEntity`, em `shared/sync.ts`) tratava "lista vazia" e "ausente" como versões diferentes.

**Origem:** o defeito é **latente desde `f5fef91`** (embalagens, Etapa 10), quando o formulário passou a enviar a lista e o Worker a omiti-la. A Etapa 11 não o introduziu nem o corrigiu. Ficou visível ao editar encomendas no staging.

### Sequência que gera a falha

1. Um aparelho salva a edição de uma encomenda **sem mudança real**: abre "Editar" e salva, ou só reconfirma os valores. Também vale para dados antigos no IndexedDB que já tinham `packagingItems: []`.
2. A única diferença entre os dados locais e a base confirmada pelo servidor é a lista vazia. `buildPushes` gera um envio.
3. `POST /api/sync/v2/push` → **200** `{revision: N+1, changed: true}`. O servidor grava de novo, porque a revisão base do cliente está em dia.
4. `GET /api/sync/v2?since=N` → **200**, com o eco **sem** `packagingItems`, igual à base anterior. `applyPull` conclui "só houve edição local": mantém a lista vazia e avança a base para o eco.
5. A diferença continua e o ciclo envia de novo. Depois de 4 tentativas, `syncOnce` devolve `status: 'error'` com "Não foi possível concluir a sincronização".
6. `AccountContext` passa à fase `error`, e `deriveIndicator` (`src/account/syncIndicator.ts`) mostra **"Falha ao sincronizar"**. As novas tentativas automáticas (recuo exponencial e foco da janela) repetem tudo: cada ciclo faz 4 gravações no D1.

**Segundo efeito:** na criação, o eco do próprio envio virava um **conflito falso** ("alterado em outro dispositivo").

### Evidências

- **Captura do navegador:** pull na revisão 1410 com a encomenda de 3 itens, seguido de push aceito na revisão 1411. É exatamente o passo 3 → 4 acima.
- **Consulta somente leitura ao D1 de staging** (SELECT, 0 linhas gravadas):
  - a encomenda `f9363938…` tem `packaging_items_json = '[]'`, 3 linhas em `order_items` e `rev = 1427`, igual à revisão da conta;
  - na captura ela estava em 1410, então continuou sendo regravada a cada ciclo;
  - 5 das 6 encomendas ativas têm a lista vazia.
- **Reprodução local:** com o Worker real e SQLite, salvar a edição sem mudança leva a `status 'error'`, 4 envios por sincronização e a revisão do servidor 3 → 7 → 11.

### Hipóteses descartadas

As hipóteses abaixo foram testadas na reprodução e não se confirmaram:
- **Leitura do ACK:** a revisão local era atualizada corretamente.
- **Protocolo:** a mudança para v2 e o roteamento do Pages funcionavam, e as rotas respondiam 200.
- **Ordem dos itens e snapshots:** idênticos após a serialização.
- **Conversão de encomendas antigas:** é determinística.
- **Conflitos reais:** continuam funcionando.

O fator decisivo foi o campo opcional omitido pelo servidor (hipóteses 8 e 16 da investigação).

## Correção

1. **Comparação canônica (`shared/sync.ts`):** em encomendas, `packagingItems` vazio, nulo ou ausente significa a mesma coisa, assim como `costSnapshot.packagingItems` de cada item.
   - É a mesma regra já usada para `packagingCharge: 0` e para as embalagens vazias das receitas.
   - Listas **com** itens, os itens da encomenda e a ordem deles continuam comparados por conteúdo (testado).
2. **Domínio (`src/domain/orders.ts`):** a encomenda nova ou editada sem embalagens adicionais não guarda a lista vazia, que é a forma devolvida pelo servidor. Remover todas as embalagens remove o campo.
3. **Proteção contra laço (`src/sync/engine.ts`):** se, no mesmo ciclo, fosse preciso reenviar uma entidade **idêntica** a uma que o servidor já aceitou, o cliente para.
   - O status vira `needs-attention`, com mensagem explicando que o servidor devolveu uma versão diferente. Isso se aplica a qualquer causa futura do mesmo tipo.
   - Os dados locais e a base ficam intactos e não há tentativas automáticas, então não há tempestade de escritas.
4. **Falhas antes escondidas, agora com causa:**
   - Confirmação do push com JSON inválido: antes era exceção solta e a tela ficava em "sincronizando". Agora é erro do servidor ("Resposta inválida do servidor.").
   - HTTP inesperado: a mensagem inclui o código (ex.: "HTTP 500").
   - Falha ao gravar o estado da sincronização no IndexedDB: antes era ignorada (`.catch(() => undefined)`) e a tela dizia "Sincronizado". Agora vira fase `error` com "armazenamento do navegador".
   - O indicador "Falha ao sincronizar" mostra a causa conhecida no detalhe.
5. **Diagnóstico opcional:** `syncOnce` aceita `trace`. O app registra, só em desenvolvimento ou com `localStorage['custo:debug-sync'] = '1'`, eventos `[sync]` com fase, tentativa, protocolo, revisões, contagens e resultado. Nunca registra conteúdo, tokens, e-mails ou valores.

## Dados existentes no staging

- **Sem migração:** nada no D1 precisa mudar. A lista `'[]'` no banco e no IndexedDB passa a ser equivalente à ausente.
- **Conflitos falsos já criados:** os pendentes cujas versões só diferiam pela lista vazia são fechados automaticamente (`healConflicts`: versões idênticas), sem perder nada.
- **Revisão:** a revisão alta da conta (1427) é só um contador; não exige reset.

## O que publicar

**Somente o frontend (Pages).** O Worker e o D1 não mudam: a correção está toda no cliente (`shared/sync.ts` é usado pelo Worker apenas em `sameEntity`, onde a nova equivalência também é correta e inofensiva).

Atualizar o Worker é opcional, só para manter `shared` idêntico nos dois lados. Se for publicado, o comportamento do servidor não muda para envios reais.

## Homologação (depois de autorizada a publicação do Pages)

1. Abrir o staging com `localStorage['custo:debug-sync'] = '1'` e o console aberto.
2. Recarregar a página: em até um ciclo, a sincronização deve concluir **sem** `POST` em laço.
3. Conferir, por consulta somente leitura, que `orders.rev` da encomenda `f9363938…` parou de subir.
4. Editar uma encomenda e salvar sem mudanças: nenhum `POST`; o estado fica "Sincronizado".
5. Editar de verdade (cliente, item, embalagem): um `POST`, um `GET` de confirmação e "Sincronizado".
6. Repetir num segundo navegador e com o celular. Recebimentos, sinal, status e os 3 itens devem estar preservados.
