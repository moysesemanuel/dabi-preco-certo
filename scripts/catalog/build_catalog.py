#!/usr/bin/env python3
"""
Gera src/features/measurement/catalog/data.ts a partir do USDA FoodData Central (SR Legacy, 2018-04; domínio público, CC0 1.0).

Nada é digitado à mão: cada peso vem do campo `gramWeight` da porção publicada pelo USDA. Este arquivo só decide QUAIS alimentos
entram, os nomes em português e quais porções de cada alimento são usadas. Se uma porção não existir no conjunto de dados, o script falha.

Uso (o conjunto de dados NÃO é versionado):
  curl -O https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip && unzip FoodData_Central_sr_legacy_food_json_2018-04.zip
  python3 -I scripts/catalog/build_catalog.py FoodData_Central_sr_legacy_food_json_2018-04.json > src/features/measurement/catalog/data.ts
"""
import json, sys

# Definições exatas das medidas americanas usadas pelo USDA (galão = 231 in³ = 3,785411784 L; xícara = galão/16; colher de sopa = xícara/16; colher de chá = colher de sopa/3).
CUP_ML = 3785.411784 / 16
TBSP_ML = CUP_ML / 16
TSP_ML = TBSP_ML / 3
VOL = {'cup': CUP_ML, 'tbsp': TBSP_ML, 'tsp': TSP_ML, 'ml': 1.0}

def v(id, label, fdc, measures, default=False, note=None):
    return dict(id=id, label=label, fdc=fdc, measures=measures, default=default, note=note)
def cup(mod): return ('cup', mod)
def tbsp(mod): return ('tbsp', mod)
def tsp(mod): return ('tsp', mod)
def unit(mod, label): return ('unit', mod, label)
def ml(mod): return ('ml', mod)

ITEMS = [
  # ---- Farinhas e amidos
  dict(id='farinha-de-trigo', name='Farinha de trigo', cat='Farinhas e amidos', syn=['farinha de trigo comum', 'farinha de trigo tradicional', 'farinha de trigo branca', 'farinha de trigo refinada'],
       variants=[v('padrao', 'Comum (branca)', 168936, [cup('cup')], True, 'Referência: farinha de trigo branca para todos os usos.')]),
  dict(id='farinha-de-trigo-integral', name='Farinha de trigo integral', cat='Farinhas e amidos', syn=[], variants=[v('padrao', 'Integral', 168893, [cup('cup')], True)]),
  dict(id='farinha-de-trigo-com-fermento', name='Farinha de trigo com fermento', cat='Farinhas e amidos', syn=['farinha com fermento', 'farinha de trigo com fermento'], variants=[v('padrao', 'Com fermento', 168895, [cup('cup')], True)]),
  dict(id='farinha-de-arroz', name='Farinha de arroz', cat='Farinhas e amidos', syn=['farinha de arroz branca'], variants=[v('padrao', 'Branca', 169714, [cup('cup')], True)]),
  dict(id='amido-de-milho', name='Amido de milho', cat='Farinhas e amidos', syn=['maisena', 'maizena'], variants=[v('padrao', 'Padrão', 169698, [cup('cup')], True)]),
  dict(id='fuba', name='Fubá', cat='Farinhas e amidos', syn=['fubá de milho'], variants=[v('padrao', 'Fubá', 169697, [cup('cup')], True, 'Referência: fubá integral amarelo (cornmeal). O fubá vendido no mercado pode variar de moagem.')]),
  # ---- Açúcares e adoçantes
  dict(id='acucar-refinado', name='Açúcar refinado', cat='Açúcares e adoçantes', syn=['açúcar', 'açúcar cristal', 'açúcar branco', 'açúcar granulado'], variants=[v('padrao', 'Granulado', 169655, [cup('cup'), tsp('tsp')], True, 'Açúcar cristal e refinado têm granulação diferente; esta é a referência de açúcar granulado.')]),
  dict(id='acucar-de-confeiteiro', name='Açúcar de confeiteiro', cat='Açúcares e adoçantes', syn=['açúcar impalpável', 'açúcar de confeitar'], variants=[
        v('sem-peneirar', 'Sem peneirar', 169656, [cup('cup unsifted'), tbsp('tbsp unsifted'), tsp('tsp')], True),
        v('peneirado', 'Peneirado', 169656, [cup('cup sifted')])]),
  dict(id='acucar-mascavo', name='Açúcar mascavo', cat='Açúcares e adoçantes', syn=['açúcar mascavo claro'], variants=[
        v('compactado', 'Compactado na medida', 168833, [cup('cup packed'), tsp('tsp packed')], True, 'Referência: açúcar mascavo ("brown sugar"), produto semelhante ao mascavo brasileiro, não idêntico.'),
        v('solto', 'Solto (sem compactar)', 168833, [cup('cup unpacked'), tsp('tsp unpacked')], False, 'Referência: açúcar mascavo ("brown sugar"), produto semelhante ao mascavo brasileiro, não idêntico.')]),
  dict(id='mel', name='Mel', cat='Açúcares e adoçantes', syn=['mel de abelha'], variants=[v('padrao', 'Padrão', 169640, [cup('cup'), tbsp('tbsp')], True)]),
  dict(id='glucose-de-milho', name='Glucose de milho', cat='Açúcares e adoçantes', syn=['xarope de milho', 'glucose'], variants=[v('padrao', 'Xarope de milho claro', 168837, [cup('cup'), tbsp('tbsp')], True, 'Referência: xarope de milho claro ("light corn syrup").')]),
  # ---- Gorduras e óleos
  dict(id='manteiga', name='Manteiga', cat='Gorduras e óleos', syn=['manteiga sem sal', 'manteiga com sal'], variants=[v('padrao', 'Com ou sem sal', 173410, [cup('cup'), tbsp('tbsp')], True, 'O USDA publica o mesmo peso (227 g por xícara) para a manteiga sem sal.')]),
  dict(id='margarina', name='Margarina', cat='Gorduras e óleos', syn=['margarina culinária', 'margarina cremosa'], variants=[v('padrao', '80% de gordura', 172346, [cup('cup'), tbsp('tbsp')], True)]),
  dict(id='oleo-de-soja', name='Óleo de soja', cat='Gorduras e óleos', syn=['óleo', 'óleo vegetal', 'óleo de cozinha'], variants=[v('padrao', 'Refinado', 172370, [cup('cup'), tbsp('tablespoon'), tsp('teaspoon')], True)]),
  dict(id='azeite-de-oliva', name='Azeite de oliva', cat='Gorduras e óleos', syn=['azeite', 'óleo de oliva'], variants=[v('padrao', 'Padrão', 171413, [cup('cup'), tbsp('tablespoon'), tsp('tsp')], True)]),
  # ---- Laticínios e ovos
  dict(id='agua', name='Água', cat='Líquidos e aromas', syn=['água filtrada', 'água mineral'], variants=[v('padrao', 'Padrão', 174158, [ml('ml')], True)]),
  dict(id='leite-integral', name='Leite integral', cat='Laticínios e ovos', syn=['leite', 'leite de vaca'], variants=[v('padrao', 'Líquido', 171265, [cup('cup'), tbsp('tbsp')], True)]),
  dict(id='leite-em-po-integral', name='Leite em pó integral', cat='Laticínios e ovos', syn=['leite em pó'], variants=[v('padrao', 'Padrão', 170876, [cup('cup')], True)]),
  dict(id='leite-condensado', name='Leite condensado', cat='Laticínios e ovos', syn=[], variants=[v('padrao', 'Adoçado', 171275, [cup('cup')], True)]),
  dict(id='leite-de-coco', name='Leite de coco', cat='Laticínios e ovos', syn=[], variants=[v('padrao', 'Enlatado', 170173, [cup('cup'), tbsp('tbsp')], True)]),
  dict(id='creme-de-leite-fresco', name='Creme de leite fresco', cat='Laticínios e ovos', syn=['creme de leite para bater'], variants=[v('padrao', 'Líquido, 36% de gordura', 170859, [cup('cup, fluid (yields 2 cups whipped)'), tbsp('tbsp')], True, 'Não é o creme de leite de caixinha. Medida do creme líquido (antes de bater).')]),
  dict(id='iogurte-natural', name='Iogurte natural', cat='Laticínios e ovos', syn=['iogurte natural integral'], variants=[v('padrao', 'Integral', 171284, [cup('cup (8 fl oz)')], True)]),
  dict(id='cream-cheese', name='Cream cheese', cat='Laticínios e ovos', syn=[], variants=[v('padrao', 'Padrão', 173418, [cup('cup'), tbsp('tbsp')], True)]),
  dict(id='creme-azedo', name='Creme azedo', cat='Laticínios e ovos', syn=['sour cream'], variants=[v('padrao', 'Padrão', 171257, [cup('cup')], True, 'O USDA publica 12 g por colher de sopa, incoerente com os 230 g por xícara; só a xícara é usada.')]),
  dict(id='queijo-parmesao-ralado', name='Queijo parmesão ralado', cat='Laticínios e ovos', syn=['parmesão ralado'], variants=[v('padrao', 'Ralado', 171247, [cup('cup')], True, 'O USDA publica 5 g por colher de sopa, incoerente com os 100 g por xícara; só a xícara é usada.')]),
  dict(id='ovo-inteiro', name='Ovo', cat='Laticínios e ovos', syn=['ovo inteiro', 'ovo de galinha', 'ovos'], variants=[
        v('pequeno', 'Pequeno', 171287, [unit('small', 'ovo pequeno')]), v('medio', 'Médio', 171287, [unit('medium', 'ovo médio')]),
        v('grande', 'Grande', 171287, [unit('large', 'ovo grande')], True), v('extra-grande', 'Extra grande', 171287, [unit('extra large', 'ovo extra grande')]),
        v('jumbo', 'Jumbo', 171287, [unit('jumbo', 'ovo jumbo')])]),
  dict(id='clara-de-ovo', name='Clara de ovo', cat='Laticínios e ovos', syn=['clara', 'claras'], variants=[v('padrao', 'Crua (ovo grande)', 172183, [unit('large', 'clara de ovo grande'), cup('cup')], True)]),
  dict(id='gema-de-ovo', name='Gema de ovo', cat='Laticínios e ovos', syn=['gema', 'gemas'], variants=[v('padrao', 'Crua (ovo grande)', 172184, [unit('large', 'gema de ovo grande'), cup('cup')], True)]),
  # ---- Fermentos e sal
  dict(id='fermento-quimico', name='Fermento químico em pó', cat='Fermentos e sal', syn=['fermento em pó', 'fermento químico', 'fermento quimico', 'fermento quimico em po', 'pó royal', 'fermento royal', 'royal'], variants=[v('padrao', 'Duplo efeito', 172803, [tsp('tsp')], True, 'Referência: fermento em pó de ação dupla.')]),
  dict(id='bicarbonato-de-sodio', name='Bicarbonato de sódio', cat='Fermentos e sal', syn=['bicarbonato'], variants=[v('padrao', 'Padrão', 175040, [tsp('tsp')], True)]),
  dict(id='fermento-biologico-seco', name='Fermento biológico seco', cat='Fermentos e sal', syn=['fermento seco', 'fermento biológico instantâneo'], variants=[v('padrao', 'Seco ativo', 175043, [tsp('tsp'), tbsp('tbsp')], True)]),
  dict(id='sal-refinado', name='Sal refinado', cat='Fermentos e sal', syn=['sal', 'sal de cozinha', 'sal fino'], variants=[v('padrao', 'De mesa', 173468, [cup('cup'), tbsp('tbsp'), tsp('tsp')], True, 'Sal grosso pesa diferente por medida.')]),
  # ---- Chocolates e cacau
  dict(id='cacau-em-po', name='Cacau em pó', cat='Chocolates e cacau', syn=['cacau em pó 100%', 'cacau em pó sem açúcar', 'cacau'], variants=[v('padrao', 'Sem açúcar', 169593, [cup('cup'), tbsp('tbsp')], True, 'Não vale para achocolatado nem chocolate em pó adoçado.')]),
  dict(id='gotas-de-chocolate-meio-amargo', name='Gotas de chocolate meio amargo', cat='Chocolates e cacau', syn=['chocolate em gotas meio amargo'], variants=[
        v('padrao', 'Gotas padrão', 167976, [cup('cup chips (6 oz package)')], True), v('mini', 'Mini gotas', 167976, [cup('cup mini chips')]), v('grandes', 'Gotas grandes', 167976, [cup('cup large chips')])]),
  dict(id='gotas-de-chocolate-ao-leite', name='Gotas de chocolate ao leite', cat='Chocolates e cacau', syn=['chocolate em gotas ao leite'], variants=[v('padrao', 'Gotas padrão', 167587, [cup('cup chips')], True)]),
  # ---- Grãos e cereais
  dict(id='arroz-branco', name='Arroz branco', cat='Grãos e cereais', syn=['arroz', 'arroz agulhinha', 'arroz branco cru'], variants=[
        v('cru', 'Cru', 168877, [cup('cup')], True), v('cozido', 'Cozido', 168878, [cup('cup')])]),
  dict(id='feijao-preto', name='Feijão preto', cat='Grãos e cereais', syn=[], variants=[v('cru', 'Cru', 173734, [cup('cup'), tbsp('tbsp')], True), v('cozido', 'Cozido (sem sal)', 173735, [cup('cup')])]),
  dict(id='aveia-em-flocos', name='Aveia em flocos', cat='Grãos e cereais', syn=['aveia'], variants=[v('padrao', 'Flocos (sem cozinhar)', 173904, [cup('cup')], True)]),
  # ---- Oleaginosas, sementes e afins
  dict(id='amendoim-cru', name='Amendoim cru', cat='Oleaginosas e sementes', syn=['amendoim'], variants=[v('padrao', 'Cru', 172430, [cup('cup')], True)]),
  dict(id='pasta-de-amendoim', name='Pasta de amendoim', cat='Oleaginosas e sementes', syn=['manteiga de amendoim', 'creme de amendoim'], variants=[v('padrao', 'Cremosa, com sal', 174266, [cup('cup')], True)]),
  dict(id='castanha-do-para', name='Castanha-do-pará', cat='Oleaginosas e sementes', syn=['castanha do pará', 'castanha-do-brasil', 'castanha do brasil'], variants=[v('padrao', 'Inteira', 170569, [cup('cup, whole')], True)]),
  dict(id='nozes', name='Nozes', cat='Oleaginosas e sementes', syn=['noz'], variants=[v('picadas', 'Picadas', 170187, [cup('cup, chopped')], True), v('moidas', 'Moídas', 170187, [cup('cup, ground')]), v('metades', 'Em metades', 170187, [cup('cup shelled (50 halves)')])]),
  dict(id='amendoas', name='Amêndoas', cat='Oleaginosas e sementes', syn=['amêndoa'], variants=[
        v('inteiras', 'Inteiras', 170567, [cup('cup, whole')], True), v('laminadas', 'Laminadas', 170567, [cup('cup, sliced')]), v('lascas', 'Em lascas', 170567, [cup('cup, slivered')]), v('moidas', 'Moídas', 170567, [cup('cup, ground')])]),
  dict(id='gergelim', name='Gergelim', cat='Oleaginosas e sementes', syn=['semente de gergelim', 'gergelim branco'], variants=[v('padrao', 'Em grãos', 170150, [cup('cup'), tbsp('tbsp')], True)]),
  dict(id='linhaca', name='Linhaça', cat='Oleaginosas e sementes', syn=['semente de linhaça'], variants=[v('inteira', 'Inteira', 169414, [cup('cup, whole'), tbsp('tbsp, whole'), tsp('tsp, whole')], True), v('moida', 'Moída', 169414, [tbsp('tbsp, ground'), tsp('tsp, ground')])]),
  dict(id='coco-ralado-adocado', name='Coco ralado adoçado', cat='Oleaginosas e sementes', syn=['coco ralado'], variants=[v('padrao', 'Adoçado, ralado', 168586, [cup('cup, shredded')], True, 'Referência de coco ralado adoçado. Para coco ralado sem açúcar não há referência verificada.')]),
  # ---- Líquidos e aromas
  dict(id='suco-de-limao', name='Suco de limão', cat='Líquidos e aromas', syn=['suco de limão taiti', 'suco de limao'], variants=[v('padrao', 'Cru', 168156, [cup('cup')], True)]),
  dict(id='suco-de-limao-siciliano', name='Suco de limão siciliano', cat='Líquidos e aromas', syn=['suco de limão-siciliano'], variants=[v('padrao', 'Cru', 167747, [cup('cup')], True)]),
  dict(id='extrato-de-baunilha', name='Extrato de baunilha', cat='Líquidos e aromas', syn=['essência de baunilha', 'baunilha líquida'], variants=[v('padrao', 'Padrão', 173471, [tsp('tsp'), tbsp('tbsp')], True, 'A essência artificial tem o mesmo peso por medida segundo o USDA.')]),
  dict(id='canela-em-po', name='Canela em pó', cat='Líquidos e aromas', syn=['canela'], variants=[v('padrao', 'Moída', 171320, [tsp('tsp'), tbsp('tbsp')], True)]),
  dict(id='gelatina-sem-sabor', name='Gelatina sem sabor', cat='Líquidos e aromas', syn=['gelatina incolor', 'gelatina em pó sem sabor'], variants=[v('padrao', 'Em pó', 169599, [tbsp('envelope (1 tbsp)')], True, '1 colher de sopa de gelatina em pó, conforme o envelope americano de referência.')]),
]

def main(path):
    foods = {f['fdcId']: f for f in json.load(open(path))['SRLegacyFoods']}
    out = []
    for item in ITEMS:
        variants = []
        for var in item['variants']:
            f = foods.get(var['fdc'])
            if not f: sys.exit(f"fdcId {var['fdc']} não existe no conjunto de dados ({item['id']})")
            ms = []
            for spec in var['measures']:
                kind, mod = spec[0], spec[1]
                portion = next((p for p in f['foodPortions'] if (p.get('modifier') or '') == mod), None)
                if not portion: sys.exit(f"porção '{mod}' não existe em {f['fdcId']} ({item['id']})")
                amount = portion.get('amount') or 1.0
                grams = round(portion['gramWeight'] / amount, 4)
                if kind == 'unit':
                    ms.append(dict(kind='unit', label=spec[2], grams=grams, usda=mod))
                else:
                    ms.append(dict(kind='volume', unit=kind, refVolumeMl=VOL[kind], grams=grams, usda=mod))
            variants.append(dict(id=var['id'], label=var['label'], default=var['default'], note=var['note'],
                                 source=dict(fdcId=f['fdcId'], ndb=int(f['ndbNumber']), description=f['description']), measures=ms))
        if not any(x['default'] for x in variants): sys.exit(f"{item['id']}: sem variante padrão")
        out.append(dict(id=item['id'], name=item['name'], category=item['cat'], synonyms=item['syn'], variants=variants))
    print("// ARQUIVO GERADO por scripts/catalog/build_catalog.py a partir do USDA FoodData Central (SR Legacy, 2018-04). Não edite à mão.")
    print("// Dados do USDA em domínio público (CC0 1.0). Citação sugerida: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.")
    print("import type { CatalogItem } from './types';\n")
    def clean(x):
        if isinstance(x, dict): return {k: clean(val) for k, val in x.items() if not (k == 'note' and val is None) and not (k == 'default' and val is False)}
        if isinstance(x, list): return [clean(i) for i in x]
        return x
    print("export const CATALOG_ITEMS: CatalogItem[] = [")
    for item in out: print("  " + json.dumps(clean(item), ensure_ascii=False, separators=(',', ':')) + ",")
    print("];")
main(sys.argv[1])
