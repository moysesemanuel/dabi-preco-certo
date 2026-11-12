# Homologação pré-beta (Etapa 4.1)

Data: 2026-11-12. Branch `feat/etapa-1-beta`. **Teste automatizado não é homologação**: a tabela separa o que foi feito num navegador real do que foi só automatizado.

## Estado do código e do staging
- O que mudou desde o Worker publicado: **só frontend** (correção do logout e da troca de conta entre abas). Nenhum arquivo de `worker/` ou `shared/` mudou desde `62b8cac`; **não é preciso atualizar o Worker de staging por causa destas correções**. Nenhuma migração nova (0001–0008). O staging ainda precisa do Worker com `catalog_ref`/`quote_code` (plano em `ATUALIZACAO_STAGING.md`, executado pelo responsável).
- `worker/wrangler.toml` e `backups/` não foram tocados. Nada foi executado contra staging/produção; o Resend não foi chamado (adaptador `dev`).

## Como foi testado no navegador real
Chrome 157 (macOS), app em `http://localhost:5174` com Worker local (`wrangler dev --local`, D1 local, licença e e-mail de teste locais, código lido do log do Worker). Controle por script na página.

| Navegador | Situação |
|---|---|
| Chrome desktop | **Testado de verdade** (cenários abaixo) |
| Safari desktop | **Não testado** (instalado, sem como controlá-lo daqui) |
| Firefox | **Não testado** (não instalado) |
| Chrome/Safari no celular | **Não testado** (sem dispositivo) |
| 320/375/390 px | **Não testado de verdade**: o Chrome não reduz a janela abaixo de ~500 px; a 500 px não houve rolagem horizontal. Falta checar em celular ou no modo dispositivo. |

## Resultados no Chrome (real)
- Login com código de 8 dígitos: ok; cookie HttpOnly (ilegível por script); sessão persiste após recarregar.
- Logout com conexão: `POST /api/auth/logout` 200, depois `GET /api/auth/session` 401 (sessão revogada, cookie removido), interface volta ao login, "Você saiu desta conta".
- Novo login após sair exigiu **novo código** (um código novo foi emitido e aceito).
- Logout sem conexão (Worker derrubado): **não** disse que saiu; manteve a sessão e mostrou "Você continua conectado: não foi possível confirmar a saída no servidor. Sem conexão…". Religado o Worker, tentar de novo funcionou.
- Duas abas: a segunda ficou em **modo de consulta** (Web Locks e BroadcastChannel disponíveis e funcionando). Saí na primeira (200) e fechei-a; o Worker registrou só uma verificação de sessão (401) e **nenhuma chamada de sincronização** da segunda aba. A tela da segunda aba não pôde ser lida depois (o grupo de abas do controle foi encerrado), então o estado final dela vem do log e dos testes automatizados.
- Não executado no navegador: janela anônima, fechar e reabrir o navegador, expiração por tempo, limite de dois dispositivos, recebimentos, offline e pesquisa de pedidos. Esses pontos estão cobertos só por testes automatizados.

## Problema encontrado e corrigido
**F3 (Baixo/Médio) — aba com sessão antiga assumia a identidade de outra conta.** Se outra aba saía e entrava com *outra* conta, a aba antiga recebia 403 no envio, relia a sessão e passava a se mostrar como a conta nova (os dados continuavam bloqueados por `account-mismatch`, mas a identidade trocava sem aviso). Reproduzido em teste (falhou antes da correção). Agora `AccountContext` encerra a sessão dessa aba com o aviso "A conta usada neste navegador mudou em outra aba. Entre de novo para continuar", sem enviar nada e sem apagar dados locais. Teste: `tests/ui/account.test.tsx` ("Troca de conta em outra aba").

## Testes automatizados adicionados
- `tests/ui/account.test.tsx`: troca de conta em outra aba (1).
- `tests/security-audit.test.ts`: logout no servidor (revoga, libera a vaga, cookie antigo 401, CSRF antigo 403) (2).
- Já existentes e reexecutados: código inválido/expirado/reutilizado, 5 tentativas, 2 sessões e substituição, expiração, revogação, financeiro e conflitos, duas abas, offline, sem polling.

## Verificações
Suíte: **840 passam, 2 ignorados**; `tsc -b`, build e `npm audit` (0) limpos. `npm run costs`: limite é escrita no D1 (~73 contas a 50%), sem serviço pago; sem polling por temporizador (teste de 8 h com duas abas).

## Limitações e checklist manual (Safari, Firefox, celular)
Para cada navegador, com a licença de teste: (1) pedir código, entrar, recarregar, fechar e reabrir o navegador e conferir que continua conectado; (2) código errado e reutilizado; (3) abrir 2ª aba: deve entrar em consulta; fechar a 1ª e ver a 2ª assumir; (4) sair com Wi-Fi desligado: deve avisar que continua conectado; religar e sair; (5) cadastrar ingrediente, criar encomenda (código ORC), registrar recebimento, recarregar; (6) modo avião: editar, voltar a rede e ver sincronizar; (7) janela anônima: sessão separada; (8) em 320/375/390 px: sem rolagem horizontal, pesquisa de encomendas e botões utilizáveis; (9) no iOS, instalar na tela inicial e repetir 1 e 5.

## Critérios de aprovação para o beta fechado
1. Checklist acima concluído sem falha em Chrome, Safari e um celular (Firefox desejável).
2. Worker de staging atualizado na ordem banco → Worker → app, com backup validado.
3. E-mail real entregue pela conta Resend definitiva (1 envio).
4. Suíte, tipos, build e auditoria limpos (já ok).
