# PedidoCerto — MVP v0.1

Aplicação independente da DaBi Price. Stack: React 19 + TypeScript + Vite 6 + Tailwind CSS 4. Persistência local com IndexedDB.

## Executar

Requisitos: Node.js 20+.

```bash
npm install
npm run dev
```

Acesse a URL exibida pelo Vite (geralmente `http://localhost:5173`). Para executar verificações:

```bash
npm run build
npm test
```

**Status de verificação (2026-11-11):** `npm run build` (tsc + vite) conclui sem erros e `npm test` passa 115/115. Os testes cobrem o domínio (`pricing.ts`, `edit.ts`), o motor de conversão e `validateBackup`; a interface não tem testes automatizados (o fluxo do conversor e da importação de receitas foi verificado manualmente no navegador).

## Estrutura

- `src/domain/types.ts`: tipos `Ingredient` (com `densityGPerMl` e `gramsPerUnit` opcionais), `Recipe`, `RecipeItem` (com `unit` opcional; ausente = unidade do ingrediente, compatível com dados antigos), `Order` e `DataSet` (`schemaVersion: 1`, com `settings.cupSizeMl` opcional). Backups antigos com `gramsPerCup` são migrados para `densityGPerMl` ao carregar/importar.
- `src/domain/pricing.ts`: `recipeCost` (custo total, unitário e preço sugerido; margem **sobre o preço de venda**: `custo / (1 − margem%)`; devolve também as linhas por ingrediente com a medida original e a convertida; lança erro em português se uma conversão necessária falhar) e `money`.
- `src/features/measurement/`: conversor de medidas. `convert.ts` (motor puro, retorna `ConversionResult` com erros controlados), `units.ts` (unidades, rótulos e formatação), `densities.ts` (referências aproximadas) e `components/MeasurementConverter.tsx`. Os ids de unidade gravados nos dados são `g, kg, ml, l, un, xic, cs, cc` (equivalentes a `cup`, `tbsp`, `tsp`, `unit` do contrato sugerido; mantidos para não migrar dados existentes).
- `src/domain/edit.ts`: funções puras de edição (`updateIngredient`, `updateRecipe`, `unitChangeAffectsRecipes`).
- `src/storage/db.ts`: persistência no IndexedDB (`pedidocerto-v1`) e `validateBackup`.
- `src/App.tsx`: casca da aplicação (carregar/salvar dados, navegação, avisos). Repassa `data`, `update`, `inform` e `focus` às páginas.
- `src/pages/`: uma página por arquivo (`DashboardPage`, `IngredientsPage`, `RecipesPage`, `OrdersPage`, `ConverterPage`, `BackupPage`), cada uma com seu próprio estado de formulário.
- `src/components/Field.tsx` e `src/utils.ts`: campo de formulário e utilitários compartilhados (`parse`, `newId`, `brDate`, `priceRecipe`, `cupSizeOf`, tipos `Page`/`PageProps`).
- `src/features/recipe-import/`: importação de receita por texto. `parse.ts` (só lê o texto, sem conversões), `resolve.ts` (liga o texto ao motor de conversão, às referências e aos ingredientes cadastrados; `analyzeRow` e `buildImport`) e `components/RecipeTextImporter.tsx`.
- `tests/`: `pricing.test.ts`, `convert.test.ts`, `recipe-parse.test.ts`, `recipe-import.test.ts`, `edit.test.ts` e `backup.test.ts`.

> Convenção do projeto: alterações que afetem o que está descrito aqui devem atualizar este README no mesmo trabalho.

## O que já está implementado

- Design system inicial, dashboard responsivo e navegação.
- Cadastro, **edição** e exclusão de ingredientes com unidade, quantidade e preço de compra. Editar o preço recalcula o custo das receitas; trocar a unidade exibe um aviso se houver receitas antigas sem unidade própria.
- Cadastro e **edição** de receitas (ingredientes, rendimento, embalagem, mão de obra e extras). Editar uma receita não altera encomendas já registradas, que guardam o próprio preço unitário.
- Cálculo de custo total, custo unitário e sugestão de preço por margem sobre venda.
- **Conversor de medidas**, como ferramenta própria (menu "Conversor") e integrado ao cadastro de receitas. Unidades: g, kg, mL, L, xícara, colher de sopa, colher de chá e unidade. Cada item da receita guarda a **medida original** (ex.: "2 xícaras") e o app converte para a unidade de compra só no cálculo; por isso alterar a densidade recalcula o custo. Xícara configurável (200, 240 ou 250 mL; padrão 240) e vale para todo o app. Entre peso e volume usa a **densidade do ingrediente** (informada como "1 xícara pesa X g"); entre unidade e peso usa "1 unidade pesa X g". Há referências aproximadas sugeridas (farinha de trigo, açúcar refinado e de confeiteiro, manteiga, óleo vegetal, água, leite integral), aplicadas só quando a pessoa clica em "Usar esta referência". Se falta uma equivalência, o app explica qual e **não calcula** aquele custo (nunca assume zero); no painel o saldo estimado vira "—".
- Cadastro de encomendas, mudança de status e cópia do texto de orçamento para WhatsApp.
- **Importação de receita por texto** (botão "Colar lista" na página de receitas): cole os ingredientes copiados da internet, um por linha. O interpretador (`features/recipe-import/parse.ts`) entende quantidades como `2`, `0,5`, `1/2`, `½`, `1 ½`, `1 1/2`, `1,5`, `meia`, `duas` e intervalos (`2 a 3`, usa o menor valor e avisa); unidades como xícara, xícara (chá), colher (sopa), colher de chá, g, kg, mL, L e unidade (com variações de escrita); e trata "a gosto", "quanto baste", "q.b." e "óleo para fritar" como quantidade indefinida. Os nomes são ligados aos ingredientes cadastrados por nome ou sinônimo (ex.: "fermento em pó", "fermento químico" e "pó Royal" são o mesmo). Uma **tabela editável** mostra quantidade, medida, ingrediente cadastrado, peso/volume convertido (≈ quando aproximado) e a referência usada; linhas incompletas ficam em "Revisar" e **não entram** na receita. Só ao clicar em "Adicionar" os itens vão para o formulário da receita (com a medida original preservada) e só ao "Salvar receita" são guardados. Se o ingrediente cadastrado não tem densidade/peso por unidade e há referência, ela é gravada no cadastro ao confirmar (a tela avisa quais). Sem IA externa e sem bibliotecas de parsing.
- Armazenamento local no IndexedDB e exportação/importação de backup JSON.
- Testes unitários do domínio de precificação, das funções de edição e da validação de backup.

## Limitações deliberadas desta etapa

- Não é uma PWA instalável nem há suporte offline garantido após fechar/reabrir o navegador; isso exige service worker e testes adicionais.
- Sem login, servidor, pagamentos, licença ou sincronização entre dispositivos.
- Densidades e equivalências por unidade são informadas por ingrediente; a tabela de referências é pequena (9 itens: farinha de trigo, açúcar refinado e de confeiteiro, manteiga, óleo vegetal, água, leite integral, ovo e fermento químico, com sinônimos), aproximada e não é aplicada automaticamente no cadastro (só por clique ou ao confirmar uma importação). A equivalência por unidade na interface é só em gramas (o motor também aceita mL por unidade).
- Xícara e colheres são convenções culinárias (240/15/5 mL), não medidas físicas exatas; por isso os resultados são marcados como aproximados (≈).
- Não há edição de encomendas (apenas o status muda); a exclusão de itens com dependentes é bloqueada.
- O resumo financeiro mostra valores estimados e não substitui contabilidade.
- O backup faz validação estrutural básica. Regras relacionais, migrações e proteção contra arquivos adulterados precisam de reforço para lançamento.
- Não há cálculos de impostos, perdas, taxas de pagamento e capacidade de produção por lote no MVP.

## Limitações da importação por texto

- Cada ingrediente da lista precisa estar **cadastrado** (com preço) para entrar na precificação; ingredientes não cadastrados aparecem convertidos (se houver referência), mas ficam fora da receita. Não há cadastro direto pela tabela.
- Sinônimos vêm da tabela interna de referências; não é possível cadastrar sinônimos próprios. A correspondência é por igualdade do nome (após remover plural e adjetivos como "peneirada"), nunca por semelhança: "leite condensado" não casa com "leite".
- Medidas sem equivalência padrão (pitada, lata, dente, colher sem "sopa"/"chá", xícara ou colher de café) exigem que a pessoa escolha a medida e ajuste a quantidade.
- Só entende o formato "quantidade + medida + ingrediente" no início da linha; "Farinha - 2 xícaras" fica sem quantidade. Ranges ("2 a 3") usam o menor valor. Não lê preparo nem separa seções além de ignorar títulos terminados em ":".
- A tabela de conversão é mais larga que a tela de celular e rola na horizontal.

## Próxima etapa proposta

1. Testar fluxo completo (incluindo a edição de ingredientes e receitas) em celular e desktop.
2. Adicionar edição de encomendas, custo de taxas e perdas, capacidade de produção e análises de prazo.
3. Habilitar PWA offline com versão e política de atualização, mais testes e2e.

## Tokens de identidade

Azul `#101F35`, laranja `#FF861C`, creme `#FAF8F4`, verde `#16794A`, vermelho `#C43D3D`. Manrope (títulos) e Inter (texto).

## Privacidade

Dados de clientes ficam apenas no navegador; não são enviados ao servidor pelo código deste MVP. Backup gerado contém dados pessoais inseridos e deve ser guardado com cuidado. O projeto carrega fontes opcionais do Google Fonts quando há acesso à internet; para distribuição estritamente offline, hospede as fontes localmente.
