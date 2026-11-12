# PedidoCerto — MVP v0.1

Aplicação independente da DaBi Price. Stack: React 19 + TypeScript + Vite 6 + Tailwind CSS 4. Persistência local com IndexedDB.

## Executar

Requisitos: **Node.js 22.18+** (os testes usam `node:sqlite` e o CLI de licenças executa TypeScript). Instruções completas em [`docs/DESENVOLVIMENTO.md`](docs/DESENVOLVIMENTO.md).

```bash
npm install
npm run dev
```

Acesse a URL exibida pelo Vite (geralmente `http://localhost:5173`). Para executar verificações:

```bash
npm run build
npm test
```

**Status de verificação (2026-11-11):** `npm run build` (tsc + vite) conclui sem erros e `npm test` passa 409/409. Os testes cobrem o domínio (`pricing.ts`, `edit.ts`), o motor de conversão e `validateBackup`; a interface tem testes de componente (`tests/ui/`, jsdom); o fluxo completo contra o Worker real foi verificado manualmente no navegador.

## Documentação

- [`docs/DESENVOLVIMENTO.md`](docs/DESENVOLVIMENTO.md): ambiente local, comandos e convenções.
- [`docs/AMBIENTES_E_VARIAVEIS.md`](docs/AMBIENTES_E_VARIAVEIS.md): ambientes (local, homologação, produção), variáveis e segredos.
- [`docs/BACKUP_E_RECUPERACAO.md`](docs/BACKUP_E_RECUPERACAO.md): backups e recuperação (aparelho e D1), com ensaio realizado.
- [`docs/SEGURANCA_CHECKLIST.md`](docs/SEGURANCA_CHECKLIST.md): o que está protegido e o que falta.
- [`docs/IMPLANTACAO_HOMOLOGACAO.md`](docs/IMPLANTACAO_HOMOLOGACAO.md): roteiro de implantação em homologação (não executado).
- [`docs/ETAPA_1_PROGRESSO.md`](docs/ETAPA_1_PROGRESSO.md): histórico e decisões da Etapa 1.
- [`worker/README.md`](worker/README.md): API, contas, sincronização, licenças e pendências do servidor.

## Estrutura

- `src/domain/types.ts`: tipos `Ingredient` (com `densityGPerMl` e `gramsPerUnit` opcionais), `Recipe`, `RecipeItem` (com `unit` opcional; ausente = unidade do ingrediente, compatível com dados antigos), `Order` e `DataSet` (`schemaVersion: 1`, com `settings.cupSizeMl` opcional). Backups antigos com `gramsPerCup` são migrados para `densityGPerMl` ao carregar/importar.
- `src/domain/pricing.ts`: `recipeCost` (custo total, unitário e preço sugerido; margem **sobre o preço de venda**: `custo / (1 − margem%)`; devolve também as linhas por ingrediente com a medida original e a convertida; lança erro em português se uma conversão necessária falhar) e `money`.
- `src/features/measurement/`: conversor de medidas. `convert.ts` (motor puro, retorna `ConversionResult` com erros controlados), `units.ts` (unidades, rótulos e formatação), `catalog/` (catálogo local e versionado de equivalências culinárias, gerado do USDA FoodData Central por `scripts/catalog/build_catalog.py`; busca por nome, apresentações e referência adotada), `densities.ts` (fachada de compatibilidade sobre o catálogo), `subject.ts` e `components/` (`MeasurementConverter`, `IngredientCombobox`). Equivalência efetiva de um ingrediente: `src/domain/equivalence.ts`. Os ids de unidade gravados nos dados são `g, kg, ml, l, un, xic, cs, cc` (equivalentes a `cup`, `tbsp`, `tsp`, `unit` do contrato sugerido; mantidos para não migrar dados existentes).
- `src/domain/edit.ts`: funções puras de edição (`updateIngredient`, `updateRecipe`, `updateOrder`, `removeOrder`, `unitChangeAffectsRecipes`).
- `src/storage/db.ts`: persistência no IndexedDB (`pedidocerto-v1`) e `validateBackup`.
- `src/App.tsx`: casca da aplicação (carregar/salvar dados, navegação, avisos). Repassa `data`, `update`, `inform` e `focus` às páginas.
- `src/pages/`: uma página por arquivo (`DashboardPage`, `IngredientsPage`, `RecipesPage`, `OrdersPage`, `ConverterPage`, `BackupPage`), cada uma com seu próprio estado de formulário.
- `src/components/Field.tsx` e `src/utils.ts`: campo de formulário e utilitários compartilhados (`parse`, `newId`, `brDate`, `priceRecipe`, `cupSizeOf`, tipos `Page`/`PageProps`).
- `src/features/recipe-import/`: importação de receita por texto. `parse.ts` (só lê o texto, sem conversões), `resolve.ts` (liga o texto ao motor de conversão, às referências e aos ingredientes cadastrados; `analyzeRow` e `buildImport`) e `components/RecipeTextImporter.tsx`.
- `shared/publicQuote.ts` e `worker/`: contrato público do orçamento e Worker de compartilhamento (ver seção acima).
- `tests/`: `pricing.test.ts`, `convert.test.ts`, `ui/` (fluxo, acessibilidade, conta, error boundary), `dataset.test.ts`, `account-client.test.ts`, `quotes-client.test.ts`, `payments.test.ts`, `schedule.test.ts`, `settings-schedule.test.ts`, `save-queue.test.ts`, `order-cost.test.ts`, `recipe-parse.test.ts`, `recipe-import.test.ts`, `public-quote.test.ts`, `worker.test.ts`, `worker-license.test.ts`, `worker-auth.test.ts`, `sync-server.test.ts`, `sync-engine.test.ts`, `license-client.test.ts`, `edit.test.ts` e `backup.test.ts`.

> Convenção do projeto: alterações que afetem o que está descrito aqui devem atualizar este README no mesmo trabalho.

## O que já está implementado

- Design system inicial, dashboard responsivo e navegação.
- Cadastro, **edição** e exclusão de ingredientes com unidade, quantidade e preço de compra. Editar o preço recalcula o custo das receitas; trocar a unidade exibe um aviso se houver receitas antigas sem unidade própria.
- Cadastro e **edição** de receitas (ingredientes, rendimento, embalagem, mão de obra e extras). Editar uma receita não altera encomendas já registradas, que guardam o próprio preço unitário.
- Cálculo de custo total, custo unitário e sugestão de preço por margem sobre venda.
- **Conversor de medidas**, como ferramenta própria (menu "Conversor") e integrado ao cadastro de receitas. Unidades: g, kg, mL, L, xícara, colher de sopa, colher de chá e unidade. Cada item da receita guarda a **medida original** (ex.: "2 xícaras") e o app converte para a unidade de compra só no cálculo; por isso alterar a densidade recalcula o custo. Xícara configurável (200, 240 ou 250 mL; padrão 240) e vale para todo o app. Entre peso e volume e entre unidade e peso o app usa as **medidas de referência do catálogo** (ingrediente do catálogo ou cadastrado) ou o valor que a pessoa informou, que tem prioridade; massa↔massa e volume↔volume funcionam sem ingrediente e são marcadas como exatas ou convencionais. Quantidades aceitam frações (1/2, 1 1/2, ½). Detalhes, fontes e licenças em `docs/CATALOGO_DE_MEDIDAS.md`.
- Cadastro e **edição** de encomendas (cliente, receita, quantidade, preço unitário, data e sinal), mudança de status e cópia do texto de orçamento para WhatsApp. Editar uma encomenda mantém o status e a data de criação, não sobrescreve o preço negociado ao trocar a receita e rejeita sinal maior que o total. Encomendas podem ser **excluídas** (com confirmação mostrando cliente e valor); isso libera a exclusão da receita, que continua bloqueada enquanto houver pedidos ligados a ela.
- **Importação de receita por texto** (botão "Colar lista" na página de receitas): cole os ingredientes copiados da internet, um por linha. O interpretador (`features/recipe-import/parse.ts`) entende quantidades como `2`, `0,5`, `1/2`, `½`, `1 ½`, `1 1/2`, `1,5`, `meia`, `duas` e intervalos (`2 a 3`, usa o menor valor e avisa); unidades como xícara, xícara (chá), colher (sopa), colher de chá, g, kg, mL, L e unidade (com variações de escrita); e trata "a gosto", "quanto baste", "q.b." e "óleo para fritar" como quantidade indefinida. Os nomes são ligados aos ingredientes cadastrados por nome ou sinônimo (ex.: "fermento em pó", "fermento químico" e "pó Royal" são o mesmo). Uma **tabela editável** mostra quantidade, medida, ingrediente cadastrado, peso/volume convertido (≈ quando aproximado) e a referência usada; linhas incompletas ficam em "Revisar" e **não entram** na receita. Só ao clicar em "Adicionar" os itens vão para o formulário da receita (com a medida original preservada) e só ao "Salvar receita" são guardados. Se o ingrediente cadastrado não tem densidade/peso por unidade e há referência, ela é gravada no cadastro ao confirmar (a tela avisa quais). Sem IA externa e sem bibliotecas de parsing.
- **Custo histórico por encomenda:** o custo unitário é registrado ao criar o pedido e não muda quando ingredientes ou receitas são alterados. Pedidos anteriores sem registro aparecem como "custo estimado com os preços atuais". Gravações no IndexedDB são serializadas (a mais antiga nunca sobrescreve a mais nova), e backups são validados com rigor (ids duplicados, relacionamentos, valores e datas). Veja `docs/ETAPA_1_PROGRESSO.md`.
- **Recebimentos:** além do sinal, cada encomenda aceita pagamentos parciais (valor, data, meio opcional, observação), com histórico e saldo pendente. O total recebido nunca passa do total da encomenda (não há crédito nem reembolso) e o total do pedido não pode ser reduzido abaixo do que já foi recebido.
- **Agenda:** entregas atrasadas, de hoje e dos próximos dias, com status editável e saldo a receber; orçamentos ficam de fora por padrão.
- **Análise de prazo (estimativa):** com o tempo de produção da receita e a capacidade diária (Configurações), mostra a carga acumulada por entrega (folga, apertado, sobrecarga) e uma dica ao registrar o pedido. É uma **estimativa simples, não uma garantia de entrega**; pedidos sem tempo informado não entram na conta.
- **Configurações do negócio:** nome e telefone (usados nos orçamentos), capacidade diária e dias de trabalho.
- Armazenamento local no IndexedDB e exportação/importação de backup JSON.
- Testes unitários do domínio de precificação, das funções de edição e da validação de backup.

## Limitações deliberadas desta etapa

- Não é uma PWA instalável nem há suporte offline garantido após fechar/reabrir o navegador; isso exige service worker e testes adicionais.
- No modo local não há login nem servidor; pagamentos e cobrança não existem nesta versão (a conta/sincronização é opcional, veja abaixo).
- O catálogo tem ~50 ingredientes verificados (USDA FoodData Central, domínio público) e é **aproximado**: nunca é aplicado sozinho, só por escolha da pessoa (ou ao confirmar uma importação). A referência adotada fica **congelada** no ingrediente (`catalogRef`), então atualizações do catálogo não mudam custos sem a pessoa aceitar; o valor informado por ela tem prioridade e fica separado. A equivalência por unidade na interface é só em gramas (o motor também aceita mL por unidade).
- Xícara e colheres são convenções culinárias (240/15/5 mL), não medidas físicas exatas; por isso os resultados são marcados como aproximados (≈).
- A exclusão de ingredientes e receitas é bloqueada enquanto houver dependentes (receitas que usam o ingrediente; encomendas que usam a receita). A exclusão de encomendas é definitiva, sem lixeira nem desfazer (a confirmação é o único aviso; exporte um backup antes de apagar dados importantes).
- O resumo financeiro mostra valores estimados e não substitui contabilidade.
- O backup faz validação estrutural básica. Regras relacionais, migrações e proteção contra arquivos adulterados precisam de reforço para lançamento.
- Não há cálculos de impostos, perdas, taxas de pagamento e capacidade de produção por lote no MVP.

## Conta, sincronização e orçamentos por link (Worker + D1)

O app é local-first e **funciona inteiro sem conta e sem internet**. Existe um serviço remoto mínimo, em `worker/` (Cloudflare Workers + D1), usado só quando a pessoa entra em uma conta liberada pela sua licença:

- **Conta** (Configurações): login sem senha por código de 8 dígitos enviado ao e-mail da compra, até **2 dispositivos** (o terceiro pode substituir um dos antigos), remoção de dispositivos e sessão em cookie `HttpOnly` com proteção CSRF.
- **Sincronização:** o servidor guarda a versão oficial dos dados e o dispositivo mantém cópia offline. Alterações offline são enviadas depois; edições do mesmo item em dois dispositivos nunca se perdem em silêncio (a versão do servidor vale e a sua fica guardada para você refazer). Dados de outra conta no mesmo dispositivo exigem decisão do usuário.
- **Orçamento por link** (botão "Orçamento por link" em cada encomenda): prévia, avisos de limitação, publicação em link curto (`/o/<id>`), copiar e compartilhar no WhatsApp; em Configurações, lista dos links publicados e **revogação**. O orçamento público nunca leva custo, margem nem dados do cliente.

Sem `VITE_API_URL` o app roda só localmente. Com `VITE_REQUIRE_LOGIN=on` (versão comercial) o app só abre com conta e licença ativa, sem apagar dados locais ([`docs/ACESSO_E_TRANSICAO.md`](docs/ACESSO_E_TRANSICAO.md)). O e-mail dos códigos usa o **Resend** (adaptador pronto; falta a chave de API) e o build gera `dist/_headers` para o Cloudflare Pages. Recebimentos em conflito entre dispositivos exigem reconciliação explícita. **Ainda não está pronto para produção** (falta deploy, DNS, chave do Resend e outras pendências); veja [`worker/README.md`](worker/README.md) e `docs/ETAPA_1_PROGRESSO.md`. Comandos: `npm run worker:migrate` (D1 local), `npm run worker:dev`, `npm run licenses -- <comando> --env local|staging|production` e `npm run d1 -- <comando> --env <ambiente>` (o ambiente é sempre explícito; `--remote` sozinho é recusado).

## Limitações da importação por texto

- Cada ingrediente da lista precisa estar **cadastrado** (com preço) para entrar na precificação; ingredientes não cadastrados aparecem convertidos (se houver referência), mas ficam fora da receita. Não há cadastro direto pela tabela.
- Sinônimos vêm da tabela interna de referências; não é possível cadastrar sinônimos próprios. A correspondência é por igualdade do nome (após remover plural e adjetivos como "peneirada"), nunca por semelhança: "leite condensado" não casa com "leite".
- Medidas sem equivalência padrão (pitada, lata, dente, colher sem "sopa"/"chá", xícara ou colher de café) exigem que a pessoa escolha a medida e ajuste a quantidade.
- Só entende o formato "quantidade + medida + ingrediente" no início da linha; "Farinha - 2 xícaras" fica sem quantidade. Ranges ("2 a 3") usam o menor valor. Não lê preparo nem separa seções além de ignorar títulos terminados em ":".
- A tabela de conversão é mais larga que a tela de celular e rola na horizontal.

## Próxima etapa proposta

1. Testar fluxo completo (incluindo a edição de ingredientes e receitas) em celular e desktop.
2. Adicionar custo de taxas e perdas, capacidade de produção e análises de prazo.
3. Habilitar PWA offline com versão e política de atualização, mais testes e2e.

## Tokens de identidade

Azul `#101F35`, laranja `#FF861C`, creme `#FAF8F4`, verde `#16794A`, vermelho `#C43D3D`. Manrope (títulos) e Inter (texto).

## Privacidade

Dados de clientes ficam apenas no navegador; não são enviados ao servidor pelo código deste MVP. Backup gerado contém dados pessoais inseridos e deve ser guardado com cuidado. O projeto carrega fontes opcionais do Google Fonts quando há acesso à internet; para distribuição estritamente offline, hospede as fontes localmente.
