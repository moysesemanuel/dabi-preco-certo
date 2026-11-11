# Acesso sem login e transição para a versão comercial

## Dois modos de build
| Modo | Como | O que acontece |
|---|---|---|
| **Local** (padrão) | `VITE_REQUIRE_LOGIN` vazio | O app abre sem conta e funciona 100% neste navegador. Conta e sincronização são opcionais. |
| **Comercial** | `VITE_REQUIRE_LOGIN=on` (e `VITE_API_URL` definido) | O app só abre com **conta e licença ativa**. Antes disso, só aparece a tela de entrada. |

## Estratégia de transição (quem já usa o modo local)
1. **Nada é apagado.** Os dados ficam no IndexedDB do navegador, exatamente como estavam. A tela de entrada diz isso e oferece **"Baixar backup"** a qualquer momento (inclusive sem login e com licença revogada).
2. Ao entrar pela primeira vez, vale o fluxo de sincronização já existente: se houver dados no dispositivo **e** na conta, nada é enviado até o usuário escolher "Combinar" (une sem apagar); dados de **outra conta** no mesmo aparelho exigem decisão explícita. Um aviso fixo no topo leva à tela de decisão.
3. Licença revogada: o app fecha, mas os dados locais continuam no navegador e podem ser exportados; nenhuma sincronização ocorre.
4. **Tolerância offline:** quem já entrou antes e perde a internet continua usando os dados do aparelho por até **7 dias** desde o último acesso verificado (aviso na tela). Com a internet de volta, o acesso é reconfirmado. Sessão **encerrada** pelo servidor (401) ou saída voluntária não ganha tolerância.

## O que o gate protege (e o que não protege)
- O gate controla o acesso à **interface**. Como o app é local-first, os dados continuam no navegador do próprio usuário; um usuário técnico pode ler o IndexedDB dele mesmo. Isso é inerente ao modelo e não é uma proteção contra o dono dos dados.
- A proteção **real** fica no servidor: sincronização, orçamentos por link, cotas e licença exigem sessão válida + CSRF + licença ativa a cada requisição (testado para todas as rotas, inclusive logo após a revogação).
- Se o produto precisar impedir o uso do código do app sem licença (por exemplo, calculadora de preços sem servidor), isso exigiria mover a lógica para o servidor — decisão de produto, fora desta etapa.

## Revogação de licença (efeito)
- Próxima requisição de qualquer sessão aberta: **403 `LICENSE_REVOKED`** em sync, orçamentos (criar/alterar/revogar/listar) e `/api/license`; o app relê a sessão e fecha o acesso.
- Novos logins: pedido de código não envia e-mail; código já enviado não abre sessão (403).
- `licenses revoke-sessions` derruba todos os dispositivos (401). `licenses revoke --revoke-quotes` retira do ar os links já publicados; **sem essa opção os links públicos continuam abertos** até serem revogados.
- Reativar (`licenses activate`) restaura o acesso sem perda de dados.

## Sessões
- Validade: **30 dias de inatividade**, renovada pelo uso (no máximo uma vez por hora), com **teto absoluto de 90 dias** desde o login; depois, novo código.
- O cookie dura 90 dias; quem decide a validade é o servidor a cada requisição. Sessão revogada ou expirada nunca é reativada.
- Troca de dispositivo (3º aparelho): o código é consumido **antes** de encerrar o dispositivo escolhido; código errado, repetido ou concorrente não derruba ninguém.
- Códigos: 8 dígitos, 10 min, 5 tentativas, uso único; pedido repetido dentro de **60 s** não envia outro e-mail nem invalida o anterior; 5 pedidos/h por e-mail; falha de envio descarta o código e devolve 503 (com `Retry-After` quando o Resend limita).
- Limite conhecido: quem conhece um e-mail pode gastar a cota de pedidos/verificações desse e-mail por 1 hora (negação de login temporária). Mitigação operacional: regra de WAF/Turnstile na rota de pedido de código (ação sua).
