# Catálogo de medidas culinárias

Permite usar xícaras, colheres e unidades nas receitas e no conversor sem que a pessoa precise saber o peso de cada ingrediente. Funciona 100% offline (o catálogo vai dentro do app, ~27 KB) e **nunca** é consultado pela rede.

## Fontes avaliadas e licenças

| Fonte | Decisão | Motivo |
|---|---|---|
| **USDA FoodData Central** (SR Legacy, abril/2018) — https://fdc.nal.usda.gov/ | **Usada** | O site declara: "dados do FoodData Central estão em domínio público, não têm copyright e são publicados sob CC0 1.0". Uso comercial e redistribuição permitidos; a citação é sugerida (feita em `data.ts` e no "Ver fonte"). Os pesos vêm do campo `gramWeight` das porções publicadas. |
| **NIST** (definições das unidades de volume) | **Usada só para as definições** | A xícara americana (usada pelo USDA) vale 236,5882365 mL; colher de sopa = xícara/16; colher de chá = colher de sopa/3 (galão = 231 in³, exato). Calculadas no código; nenhuma tabela foi copiada. |
| **King Arthur Baking — Ingredient Weight Chart** | **Não usada** | A página é protegida ("All rights reserved") e não traz licença de reutilização. Nenhum valor foi copiado. |
| **TBCA/USP** — http://www.tbca.net.br/ | **Não usada** | O texto do site diz: "Não é permitida a reprodução total ou parcial do material", com citação obrigatória da fonte. Além disso, é uma base de composição nutricional, não de medidas caseiras. |

Nenhum valor foi estimado, inventado ou gerado por IA. Se uma porção não existe na fonte, o script de geração falha em vez de preencher.

## O que existe hoje

~50 itens (farinhas e amidos, açúcares, gorduras, laticínios e ovos, fermentos e sal, chocolates e cacau, grãos, oleaginosas, líquidos e aromas). Cada item tem **apresentações** próprias (ex.: açúcar de confeiteiro *peneirado* × *sem peneirar*; açúcar mascavo *compactado* × *solto*; arroz e feijão *cru* × *cozido*; ovo por tamanho) e cada apresentação aponta para o alimento do USDA (FDC id) e para as porções usadas. Mostra-se a lista em `src/features/measurement/catalog/data.ts` (arquivo **gerado**; não edite à mão).

Regenerar (o conjunto de dados do USDA não é versionado):

```bash
curl -O https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip && unzip FoodData_Central_sr_legacy_food_json_2018-04.zip
python3 -I scripts/catalog/build_catalog.py FoodData_Central_sr_legacy_food_json_2018-04.json > src/features/measurement/catalog/data.ts
```
Ao mudar qualquer valor, nome ou sinônimo, altere `CATALOG_VERSION` em `catalog/index.ts`.

## Como o app evita equivalências erradas

- **A xícara do USDA é a americana (236,588 mL), não 240 mL.** O catálogo guarda gramas e o volume real da medida; a densidade (g/mL) sai da divisão, e o peso de uma xícara de 240 mL (ou 200/250) é calculado a partir dela. Por isso "1 xícara de farinha" dá ≈ 126,8 g (não 125 g).
- **Volume, massa e unidade são tipos diferentes** (`kind: 'volume' | 'unit'`); massa↔massa e volume↔volume não dependem do catálogo.
- **Correspondência por igualdade**, sem fuzzy: ignora maiúsculas, acentos, plural e adjetivos de preparo ("peneirada", "grandes", "sem sal"). Nome incompleto ou genérico ("farinha", "chocolate") só **sugere**; produtos parecidos não se confundem ("leite" ≠ "leite condensado", "creme de leite" de caixinha ≠ "creme de leite fresco"). Um teste garante que nenhum nome/sinônimo aponta para dois itens.
- **Nada é aplicado sozinho:** a referência só entra no ingrediente quando a pessoa clica em "Usar medidas de referência" (ou confirma uma importação de receita).
- **Itens com medidas incoerentes na fonte** (ex.: creme azedo, 12 g/colher de sopa × 230 g/xícara) usam só a medida coerente; um teste confere que as medidas do mesmo alimento batem entre si (±8%).
- **Produtos análogos, não idênticos** (açúcar mascavo ← *brown sugar*, fubá ← *cornmeal*, glucose de milho ← *corn syrup*) trazem uma observação visível.
- **Ingrediente fora do catálogo** continua cadastrável; a pessoa informa os pesos ou deixa em branco (o app recusa o cálculo em vez de assumir).

## Modelo de dados (compatível com o que já existe)

`Ingredient.densityGPerMl` / `gramsPerUnit` continuam sendo o valor **informado pela pessoa** (prioridade). Novo campo opcional `Ingredient.catalogRef = { id, variant, version, densityGPerMl?, gramsPerUnit? }`: a referência adotada, com os **valores congelados** no momento da adoção. Equivalência efetiva (`effectiveEquivalence`): informado → referência adotada → nenhuma.

Consequências:
- Ingredientes e backups existentes funcionam sem mudança (campo ausente) e **nenhum custo muda sozinho**.
- Atualizar o catálogo **não altera custos**. Se os valores atuais do catálogo diferem dos congelados, o ingrediente mostra "Ver o efeito e atualizar" com as receitas afetadas antes de confirmar.
- Salvar uma mudança de medidas informa quais receitas mudaram de custo. Encomendas e `costSnapshot` nunca são recalculados.
- O conversor aceita frações (`1/2`, `1 1/2`, `½`), classifica o resultado como *exato*, *convencional* (xícara/colher) ou *aproximado por referência/valor informado* e recusa combinações sem significado físico (unidade → volume).

## Sincronização e backup

`catalogRef` viaja com o ingrediente (coluna `ingredients.catalog_ref`, JSON). Conflitos entre sessões seguem a mesma regra dos demais campos (as duas versões ficam preservadas e a pessoa decide; o campo aparece como "Medidas de referência"). O backup `.json` inclui o campo; backups antigos continuam válidos. Valores externos são validados (forma, tamanho, números positivos), mas **não** contra a versão local do catálogo, para que dados de uma versão futura nunca se tornem ilegíveis.

## Migração (NÃO executada)

`worker/migrations/0007_catalog_ref.sql`: `ALTER TABLE ingredients ADD COLUMN catalog_ref TEXT;` (aditiva e reversível por não usar a coluna; sem perda de dados).

Ordem de publicação: **1)** aplicar a migração (`npm run d1 -- migrate --env staging`, depois produção, com as confirmações do CLI); **2)** publicar o Worker; **3)** publicar o app. Se o app novo for publicado antes do Worker novo, o servidor antigo descarta o campo e o app reenviaria a referência a cada sincronização.

## Limitações conhecidas

- Valores aproximados: variam com marca, compactação e forma de medir (por isso o aviso e o "ajustar").
- A fonte é americana: alimentos brasileiros sem equivalente no USDA (polvilho, farinha de mandioca, requeijão, goiabada, achocolatado, creme de leite de caixinha, coco ralado sem açúcar) **não** estão no catálogo, e não foram aproximados por outros.
- O ovo usa o peso do ovo sem casca por tamanho (grande = 50 g); ovos brasileiros costumam ser classificados de outra forma.
- A apresentação padrão é uma sugestão; a pessoa pode trocá-la.
