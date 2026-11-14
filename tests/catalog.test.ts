import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_SOURCE, CATALOG_VERSION, equivalenceOf, findItem, findVariant, makeRef, nameCandidates, normalizeText, refDiffersFromCatalog, searchCatalog, type VolumeMeasure } from '../src/features/measurement/catalog';

// Medidas americanas usadas pelo USDA: definições exatas (galão = 231 in³ = 3,785411784 L).
const CUP = 3785.411784 / 16, TBSP = CUP / 16, TSP = TBSP / 3;
const REF_ML = { cup: CUP, tbsp: TBSP, tsp: TSP, ml: 1 } as const;

describe('Integridade do catálogo', () => {
  it('tem versão, fonte e licença declaradas', () => {
    expect(CATALOG_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    expect(CATALOG_SOURCE.license).toMatch(/CC0/); expect(CATALOG_SOURCE.name).toMatch(/USDA/);
    expect(CATALOG.length).toBeGreaterThanOrEqual(40);
  });
  it('ids estáveis e únicos; exatamente uma apresentação padrão por item', () => {
    expect(new Set(CATALOG.map(i => i.id)).size).toBe(CATALOG.length);
    for (const item of CATALOG) {
      expect(item.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(new Set(item.variants.map(v => v.id)).size).toBe(item.variants.length);
      expect(item.variants.filter(v => v.default)).toHaveLength(1);
    }
  });
  it('toda apresentação cita a fonte (FDC) e usa volumes de referência exatos', () => {
    for (const item of CATALOG) for (const v of item.variants) {
      expect(v.source.fdcId, item.id).toBeGreaterThan(100000); expect(v.source.description.length, item.id).toBeGreaterThan(3);
      expect(v.measures.length, item.id).toBeGreaterThan(0);
      for (const m of v.measures) {
        expect(m.grams, `${item.id}/${v.id}`).toBeGreaterThan(0); expect(m.usda.length).toBeGreaterThan(0);
        if (m.kind === 'volume') expect(m.refVolumeMl, `${item.id}/${v.id}`).toBeCloseTo(REF_ML[m.unit], 9);
      }
    }
  });
  it('densidades plausíveis (0,2 a 1,5 g/mL) e medidas do mesmo alimento coerentes entre si (±8%)', () => {
    for (const item of CATALOG) for (const v of item.variants) {
      const eq = equivalenceOf(v);
      if (eq.densityGPerMl !== undefined) { expect(eq.densityGPerMl, `${item.id}/${v.id}`).toBeGreaterThan(0.2); expect(eq.densityGPerMl).toBeLessThan(1.5); }
      const dens = v.measures.filter((m): m is VolumeMeasure => m.kind === 'volume').map(m => m.grams / m.refVolumeMl);
      if (dens.length > 1) for (const d of dens) expect(Math.abs(d - dens[0]) / dens[0], `${item.id}/${v.id}`).toBeLessThan(0.08);
    }
  });
  it('nenhum nome ou sinônimo aponta para dois itens diferentes (sem ambiguidade escondida)', () => {
    const owner = new Map<string, string>();
    for (const item of CATALOG) for (const a of [item.name, ...item.synonyms].map(normalizeText)) {
      expect(owner.get(a) ?? item.id, `"${a}" em ${item.id}`).toBe(item.id); owner.set(a, item.id);
    }
  });
  it('não "adivinha": ovos e açúcar diferem por apresentação, não por inventar pesos', () => {
    const ovo = findItem('ovo-inteiro')!;
    expect(ovo.variants.map(v => equivalenceOf(v).gramsPerUnit)).toEqual([38, 44, 50, 56, 63]);
    const confeiteiro = findItem('acucar-de-confeiteiro')!;
    const d = (id: string) => equivalenceOf(findVariant(confeiteiro, id)).densityGPerMl!;
    expect(d('peneirado') / d('sem-peneirar')).toBeCloseTo(100 / 120, 9); // peneirado ≠ solto (USDA: 100 g × 120 g por xícara)
    const mascavo = findItem('acucar-mascavo')!;
    expect(equivalenceOf(findVariant(mascavo, 'compactado')).densityGPerMl!).toBeGreaterThan(equivalenceOf(findVariant(mascavo, 'solto')).densityGPerMl!);
  });
  it('a xícara de referência é a americana (236,588 mL), não 240 mL', () => {
    const d = equivalenceOf(findVariant(findItem('farinha-de-trigo')!)).densityGPerMl!;
    expect(d).toBeCloseTo(125 / 236.5882365, 9);
    expect(d * 240).toBeCloseTo(126.8, 1); // 1 xícara de 240 mL de farinha ≈ 126,8 g
  });
  it('água: 1 g/mL', () => { expect(equivalenceOf(findVariant(findItem('agua')!)).densityGPerMl).toBe(1); });
});

describe('Busca por nome', () => {
  it('ignora maiúsculas e acentos', () => {
    for (const q of ['Farinha de Trigo', 'FARINHA DE TRIGO', 'farinha de trigo']) expect(searchCatalog(q).exact?.id).toBe('farinha-de-trigo');
    expect(searchCatalog('açucar DE CONFEITEIRO').exact?.id).toBe('acucar-de-confeiteiro');
    expect(searchCatalog('acucar de confeiteiro').exact?.id).toBe('acucar-de-confeiteiro');
  });
  it('sinônimos, plural e adjetivos de preparo', () => {
    expect(searchCatalog('maisena').exact?.id).toBe('amido-de-milho');
    expect(searchCatalog('pó royal').exact?.id).toBe('fermento-quimico');
    expect(searchCatalog('açúcar').exact?.id).toBe('acucar-refinado');
    expect(searchCatalog('ovos grandes').exact?.id).toBe('ovo-inteiro');
    expect(searchCatalog('manteiga sem sal').exact?.id).toBe('manteiga');
    expect(searchCatalog('Farinha de trigo peneirada').exact?.id).toBe('farinha-de-trigo');
  });
  it('nome incompleto ou genérico só SUGERE (ambíguo), nunca escolhe', () => {
    const r = searchCatalog('farinha');
    expect(r.exact).toBeUndefined();
    expect(r.suggestions.map(s => s.id)).toEqual(expect.arrayContaining(['farinha-de-trigo', 'farinha-de-trigo-integral', 'farinha-de-arroz']));
    expect(searchCatalog('chocolate').exact).toBeUndefined(); expect(searchCatalog('chocolate').suggestions.length).toBeGreaterThan(1);
  });
  it('produtos parecidos não são confundidos', () => {
    expect(searchCatalog('leite condensado').exact?.id).toBe('leite-condensado');
    expect(searchCatalog('leite').exact?.id).toBe('leite-integral');
    expect(searchCatalog('leite de coco').exact?.id).toBe('leite-de-coco');
    const cx = searchCatalog('creme de leite'); // creme de leite de caixinha NÃO é o creme de leite fresco
    expect(cx.exact).toBeUndefined(); expect(cx.suggestions.map(s => s.id)).toContain('creme-de-leite-fresco');
    expect(searchCatalog('achocolatado').exact).toBeUndefined(); expect(searchCatalog('chocolate em pó').exact).toBeUndefined();
    expect(searchCatalog('farinha de mandioca').exact).toBeUndefined(); expect(searchCatalog('polvilho').exact).toBeUndefined();
  });
  it('ingrediente desconhecido ou texto vazio: nada encontrado, sem bloquear', () => {
    expect(searchCatalog('xyzzy raro')).toEqual({ exact: undefined, suggestions: [] });
    expect(searchCatalog('')).toEqual({ suggestions: [] }); expect(searchCatalog('   ')).toEqual({ suggestions: [] });
    expect(searchCatalog('a').suggestions).toEqual([]);
  });
  it('normaliza texto e candidatos', () => {
    expect(normalizeText('  Açúcar  Refinado!! ')).toBe('acucar refinado');
    expect(nameCandidates('Ovos grandes')).toEqual(['ovos', 'ovo']); // sem o adjetivo de tamanho, com e sem plural
  });
});

describe('Referência adotada (valores congelados e versionamento)', () => {
  it('makeRef congela versão e valores; id inexistente não gera referência', () => {
    const ref = makeRef('farinha-de-trigo')!;
    expect(ref).toMatchObject({ id: 'farinha-de-trigo', variant: 'padrao', version: CATALOG_VERSION });
    expect(ref.densityGPerMl).toBeCloseTo(125 / 236.5882365, 9); expect(ref.gramsPerUnit).toBeUndefined();
    expect(makeRef('inexistente')).toBeUndefined();
    expect(makeRef('ovo-inteiro', 'extra-grande')!.gramsPerUnit).toBe(56);
    expect(makeRef('ovo-inteiro', 'variante-que-nao-existe')!.variant).toBe('grande'); // cai na apresentação padrão
  });
  it('detecta quando o catálogo atual difere da referência congelada (e só então)', () => {
    const ref = makeRef('farinha-de-trigo')!;
    expect(refDiffersFromCatalog(ref)).toBe(false);
    expect(refDiffersFromCatalog({ ...ref, version: '2025.01.1', densityGPerMl: 0.5 })).toBe(true);
    expect(refDiffersFromCatalog({ ...ref, version: '2025.01.1' })).toBe(false); // versão antiga com os mesmos valores: nada mudou
  });
});
