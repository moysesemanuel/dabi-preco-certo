# Várias abas do mesmo navegador e o armazenamento local

## O problema (reproduzido, não suposto)

Todas as abas da mesma origem compartilham **um** IndexedDB. O app guardava os dados como **um único documento** (`data`) e o estado de sincronização em outro (`sync`); cada aba carrega o documento na memória e, a cada edição, **regrava o documento inteiro** (a fila de gravação só serializa dentro da própria aba). Não havia nenhuma coordenação entre abas.

Reprodução em teste (duas cópias do app sobre o mesmo IndexedDB) **e em Chrome real** (duas abas, código anterior): aba A salva o ingrediente *a* = R$ 9; aba B, que carregou antes, salva o ingrediente *b* = R$ 7 → no disco ficou **a = R$ 6 (a edição de A sumiu)**, b = 7. Nenhum aviso. O mesmo vale para recebimentos (um recebimento lançado numa aba some quando a outra grava; a pessoa pode então lançá-lo de novo, **duplicando dinheiro**) e para o estado de sincronização. Uma aba também podia sincronizar com a identidade (cookie compartilhado) de outra conta depois de uma troca de conta em outra aba.

Não é o simples fato de compartilhar o banco que causava a perda: é a combinação *documento inteiro + gravação cega + várias abas*.

## Alternativas avaliadas

| Alternativa | Veredito |
|---|---|
| **Web Locks API** (exclusão mútua) | **Usada** para escolher UMA aba editora. O navegador solta o bloqueio sozinho se a aba fechar, travar ou for descartada, e quem esperava assume. Não depende de memória nem de mensagens. Suporte: Chrome/Edge 69+, Firefox 96+, Safari 15.4+. |
| **Comparar-e-trocar (CAS) no IndexedDB** | **Usada como rede de segurança e como alternativa sem Web Locks.** Cada gravação lê a versão do documento e grava na MESMA transação (o navegador serializa transações); versão diferente = recusa, nada é gravado. |
| **BroadcastChannel** | **Usado só para avisar** as abas em consulta que há dados novos (nunca como exclusão mútua, pois mensagens se perdem em abas suspensas). Sem ele, elas releem ao voltar o foco. |
| Aba líder só para sincronização | Insuficiente: o problema é a gravação local concorrente, não só a rede. |
| Mesclar alterações de várias abas (merge de documentos) | Descartada: exigiria reescrever as edições como operações e reimplementar a mesclagem/conflitos que já existem entre aparelhos; complexidade desproporcional. |
| Gravação por registro (várias chaves) | Descartada: mudaria o modelo de dados, o backup e a sincronização. |

**Escolha:** uma aba edita por vez (Web Locks) + CAS por versão. A coordenação roda no navegador: **zero requisições à Cloudflare**, sem temporizadores.

## Como funciona

- A primeira aba aberta é a **editora**. As demais ficam em **modo de consulta**: veem os dados (atualizados quando a editora grava, por BroadcastChannel ou ao voltar o foco), podem navegar e pesquisar, mas **não gravam nem sincronizam**; Configurações e Backup mostram uma explicação. Qualquer tentativa de alterar mostra "Esta aba está em modo de consulta. Assuma a edição para alterar." (nenhuma mensagem de sucesso falsa).
- **"Editar nesta aba"** assume a edição; a editora anterior vira consulta. A aba que assume é bloqueada (sem editar e sem sincronizar) até **reler os dados do disco** e **verificar a sessão de novo** (o cookie é compartilhado e a conta pode ter mudado). Se o aparelho guarda dados de outra conta, o bloqueio de conta existente impede baixar ou enviar qualquer coisa.
- Se a editora **fecha, trava ou é descartada**, o navegador solta o bloqueio e a próxima aba assume sozinha (mesmo fluxo de releitura e verificação).
- Só a aba editora sincroniza com a nuvem, então duas abas nunca enviam o mesmo recebimento: a idempotência existente (IDs estáveis, `addPayment` recusa ID repetido, servidor trata reenvio idêntico como "sem alteração") continua valendo.
- **Sem Web Locks** (navegador antigo): todas aparecem como editoras, mas cada gravação confere a versão. Se outra aba gravou antes, a gravação é **recusada** (nada é apagado) e a aba mostra: "Os dados foram alterados em outra aba… as últimas alterações desta aba não foram salvas", com **"Baixar cópia das minhas alterações"** e **"Carregar os dados atuais"**.
- Gravação durante o fechamento: dados e versão vão na mesma transação do IndexedDB (atômica); ou entram os dois, ou nenhum.

## Consumo (política de custos)

Nenhuma requisição nova: sem polling, sem sincronização contínua. A aba em consulta só faz a verificação de sessão ao abrir (1 requisição por aba aberta) e **nenhuma** sincronização (teste: um retorno de foco com duas abas = 1 verificação, não 2). Em 8 h com duas abas abertas: 0 requisições por temporizador.

## Testes

`tests/coordination.test.ts` (papéis, fila, assumir, fechar, StrictMode, sem Web Locks), `tests/storage-cas.test.ts` (versão, gravação simultânea: uma vence), `tests/ui/multi-tab.test.tsx` (cenários A–J com duas cópias do app, Web Locks e BroadcastChannel simulados em `tests/helpers/locks.ts`), e verificação **manual em Chrome real** (Web Locks, BroadcastChannel e IndexedDB reais): código anterior perdeu a edição; código novo preservou as duas, o recebimento e promoveu a aba ao fechar a editora.

## Limitações conhecidas

- O simulador de Web Locks dos testes reproduz a semântica, **não** o navegador: por isso a verificação em Chrome real. **Firefox e Safari não foram exercitados** (dependem do suporte padrão da API).
- Uma aba que fica **congelada** (não descartada) segue segurando o bloqueio; as outras ficam em consulta até a pessoa clicar em "Editar nesta aba".
- Janela anônima e perfil diferente têm armazenamento separado: continuam sendo "outro aparelho" e passam pela sincronização/conflitos normais.
- Perda por falha de disco/navegador no meio de uma gravação não é simulada em teste (a atomicidade vem da transação do IndexedDB).
- O estado de sincronização (`sync`) só é gravado pela aba editora; uma aba que perdeu a edição durante uma sincronização em andamento pode terminar esse ciclo, e o resultado é descartado pelo controle de versão/recarga na próxima assunção.

## Homologação manual

1. `npm run dev:staging`, abra o app em **duas abas**: a segunda mostra "Este aplicativo está aberto em outra aba".
2. Na primeira, edite um ingrediente: a segunda mostra o novo valor sem recarregar. Na segunda, tente editar: a mensagem de consulta aparece e nada muda.
3. Na segunda, "Editar nesta aba", edite outro ingrediente e registre um recebimento: confira que as duas edições e o recebimento (uma vez só) estão presentes e a primeira aba passou a consulta.
4. Feche a aba editora: a outra assume sozinha e consegue editar.
5. Com o `wrangler tail`, confirme que a aba em consulta não gera nenhum `GET /api/sync`.
