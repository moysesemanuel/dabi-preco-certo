import type { MeasureUnit } from '../../domain/types';

/**
 * Interpretador de texto de receitas. Só lê o texto: não converte medidas (isso é do motor em features/measurement)
 * e não consulta ingredientes cadastrados. Funções puras, sem dependências.
 */
export type ParsedLine = {
  /** Linha original, sem marcadores de lista. */
  raw: string;
  /** Nome do ingrediente, sem quantidade, medida, "para fritar", "a gosto" nem observações após vírgula/parênteses. */
  name: string;
  quantity?: number;
  unit?: MeasureUnit;
  /** Texto de uma medida que existe na receita mas não é suportada (ex.: "pitada", "lata", "colher"). */
  unitLabel?: string;
  /** Sem quantidade definida: "a gosto", "quanto baste", "óleo para fritar" ou linha sem número. */
  indefinite: boolean;
  notes: string[];
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const FRACTIONS: Record<string, number> = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
const FR = Object.keys(FRACTIONS).join('');
const WORD_NUMBERS: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, meio: 0.5, meia: 0.5 };

type Read = { value: number; length: number };

function readNumber(s: string): Read | null {
  let m = s.match(new RegExp(`^(\\d+)\\s*([${FR}])`));
  if (m) return { value: Number(m[1]) + FRACTIONS[m[2]], length: m[0].length };
  m = s.match(new RegExp(`^([${FR}])`));
  if (m) return { value: FRACTIONS[m[1]], length: m[0].length };
  m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (m && Number(m[3]) > 0) return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), length: m[0].length };
  m = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (m && Number(m[2]) > 0) return { value: Number(m[1]) / Number(m[2]), length: m[0].length };
  m = s.match(/^(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)/);
  if (m) {
    const t = m[1];
    // "1.000" é mil; "0.500" e "1.5" são decimais
    const value = /^[1-9]\d{0,2}(\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t.replace(',', '.'));
    return { value, length: m[0].length };
  }
  return null;
}

/** Lê a quantidade no início do texto: 2, 0,5, 1/2, ½, 1 ½, 1 1/2, 1,5, "meia", "duas", "2 a 3". */
export function parseQuantity(input: string): { value: number; length: number; note?: string } | null {
  const lead = input.length - input.trimStart().length;
  const s = input.slice(lead);
  let n = readNumber(s);
  if (!n) {
    const w = fold(s).toLowerCase().match(/^(um|uma|dois|duas|tres|quatro|cinco|meio|meia)(?![a-z])/);
    if (w) n = { value: WORD_NUMBERS[w[1]], length: w[0].length };
  }
  if (!n) return null;
  let end = n.length;
  let note: string | undefined;
  const range = s.slice(end).match(/^\s*(?:a|à|ate|até|ou|-|–)\s*(?=\d)/i);
  if (range) {
    const n2 = readNumber(s.slice(end + range[0].length));
    if (n2) { end += range[0].length + n2.length; note = `Intervalo na receita: usei o menor valor (${n.value}). Ajuste se necessário.`; }
  }
  return { value: n.value, length: lead + end, note };
}

type UnitMatch = { length: number; unit?: MeasureUnit; label?: string };

/** Reconhece a medida no início de `f` (texto sem acentos e em minúsculas). */
function readUnit(f: string): UnitMatch | null {
  const t = f.trimStart();
  const lead = f.length - t.length;
  const hit = (m: RegExpMatchArray | null, extra: Partial<UnitMatch>): UnitMatch | null => (m ? { length: lead + m[0].length, ...extra } : null);

  let m = t.match(/^xicaras?\s*\(\s*cafe\s*\)(?![a-z])|^xicaras?\s+de\s+cafe(?![a-z])/);
  if (m) return hit(m, { label: 'xícara de café' });
  m = t.match(/^(?:xicaras?|xic)\.?(?:\s*\(\s*(?:de\s+)?cha\s*\)|\s+de\s+cha(?![a-z]))?(?![a-z])/);
  if (m) return hit(m, { unit: 'xic' });

  m = t.match(/^(?:colher(?:es)?|colh|col)\.?/);
  if (m) {
    const rest = t.slice(m[0].length);
    const kind = rest.match(/^\s*(?:\(\s*(?:de\s+)?(sopa|cha|cafe|sobremesa)\s*\)|(?:de\s+)?(sopa|cha|cafe|sobremesa)(?![a-z]))/);
    const which = kind ? (kind[1] ?? kind[2]) : undefined;
    const length = lead + m[0].length + (kind ? kind[0].length : 0);
    if (which === 'sopa') return { length, unit: 'cs' };
    if (which === 'cha') return { length, unit: 'cc' };
    if (which) return { length, label: `colher de ${which === 'cafe' ? 'café' : which}` };
    if (/^(?![a-z])/.test(rest)) return { length, label: 'colher' };
  }
  m = t.match(/^(?:csp|cs|c\.\s?sopa)(?![a-z])/);
  if (m) return hit(m, { unit: 'cs' });
  m = t.match(/^(?:cch|cc|c\.\s?cha)(?![a-z])/);
  if (m) return hit(m, { unit: 'cc' });

  m = t.match(/^(?:kg|quilos?|quilogramas?)(?![a-z])/);
  if (m) return hit(m, { unit: 'kg' });
  m = t.match(/^(?:gramas?|gr|g)(?![a-z])\.?/);
  if (m) return hit(m, { unit: 'g' });
  m = t.match(/^(?:mililitros?|ml)(?![a-z])/);
  if (m) return hit(m, { unit: 'ml' });
  m = t.match(/^(?:litros?|lt|l)(?![a-z])/);
  if (m) return hit(m, { unit: 'l' });
  m = t.match(/^(?:unidades?|unid|un)(?![a-z])\.?/);
  if (m) return hit(m, { unit: 'un' });
  return null;
}

/** Medidas de embalagem/porção que existem em receitas mas não têm equivalência padrão. */
const CONTAINER = /^(pitadas?|latas?|caixas?|caixinhas?|pacotes?|saches?|dentes?|fatias?|pedacos?|macos?|punhados?|tabletes?|barras?|copos?|envelopes?|fios?|ramos?|folhas?|potes?)\s+(?:de|do|da)\s+/;

const GOSTO = /a gosto/;
const QB = /(?:^|\s)q\.?\s?b\.?(?=\s|$|,)/;
const ENOUGH = /\b(?:suficiente|o necessario|necessario)\b/;
const POUCO = /\b(?:um pouco|um pouquinho|pouco|pouquinho)\b(?:\s+de\b)?/;
const PARA = /\s+para\s+(?:o\s+|a\s+)?(?:fritar|fritura|untar|polvilhar|decorar|empanar|banhar|pincelar|cobrir|rechear|forma|enfeitar|servir|acompanhar|regar)\b.*$/;

function removeMatch(s: string, f: string, re: RegExp): { s: string; f: string; hit: boolean } {
  const m = re.exec(f);
  if (!m) return { s, f, hit: false };
  const cut = (x: string) => `${x.slice(0, m.index)} ${x.slice(m.index + m[0].length)}`;
  return { s: cut(s), f: cut(f), hit: true };
}

/** Interpreta uma linha de ingrediente. Devolve null para linhas vazias e títulos de seção ("Massa:"). */
export function parseIngredientLine(line: string): ParsedLine | null {
  let s = line.normalize('NFC').replace(/^[\s•·*▪◦○●✓✔☐▢\-–—]+/, '').trim();
  if (!s || /:\s*$/.test(s)) return null;
  const raw = s;
  let f = fold(s).toLowerCase();
  if (f.length !== s.length) s = f; // segurança: mantém os índices alinhados
  const notes: string[] = [];

  let marker = false;
  for (const re of [GOSTO, QB, ENOUGH, POUCO, PARA]) {
    const r = removeMatch(s, f, re);
    if (r.hit) { s = r.s; f = r.f; marker = true; }
  }
  s = s.replace(/\s+/g, ' ').trim();
  f = f.replace(/\s+/g, ' ').trim();

  let quantity: number | undefined;
  let unit: MeasureUnit | undefined;
  let unitLabel: string | undefined;

  const q = parseQuantity(s);
  if (q) {
    quantity = q.value;
    if (q.note) notes.push(q.note);
    s = s.slice(q.length); f = f.slice(q.length);
    const u = readUnit(f);
    if (u) {
      unit = u.unit; unitLabel = u.label;
      s = s.slice(u.length); f = f.slice(u.length);
    } else {
      const c = f.trimStart().match(CONTAINER);
      if (c) {
        const lead = f.length - f.trimStart().length;
        unitLabel = s.trimStart().slice(0, c[1].length);
        s = s.slice(lead + c[0].length); f = f.slice(lead + c[0].length);
      } else {
        unit = 'un'; // "2 ovos": a unidade é implícita
      }
    }
  }

  let name = s.trim().replace(/^(?:de|do|da|d['’])\s+/i, '');
  const cut = name.search(/[,;(]|\s[-–]\s/);
  if (cut >= 0) name = name.slice(0, cut);
  name = name.replace(/[.\s:]+$/, '').trim();

  const indefinite = quantity === undefined;
  if (indefinite) notes.push(marker ? 'Quantidade indefinida ("a gosto", "quanto baste", "para fritar"): informe a quantidade a usar.' : 'Linha sem quantidade: informe a quantidade a usar.');
  return { raw, name, quantity, unit, unitLabel, indefinite, notes };
}

/** Interpreta uma lista colada, uma linha por ingrediente. */
export function parseIngredientList(text: string): ParsedLine[] {
  return text.split(/\r?\n/).map(parseIngredientLine).filter((l): l is ParsedLine => l !== null);
}
