import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// O jsdom não carrega o CSS, então estas regras são conferidas no próprio arquivo. A validação visual real foi feita no Chrome (320–1400 px).
const css = readFileSync('src/styles.css', 'utf8');
const rule = (selector: string) => { const i = css.indexOf(selector + '{'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1); };

describe('Pesquisa expansível: estilos que impedem borda dupla, "x" duplicado e compressão', () => {
  it('só o campo (.search-field) tem borda e anel de foco; o input global é neutralizado', () => {
    expect(rule('.search-field')).toMatch(/border:1px solid/); expect(rule('.search-field:focus-within')).toMatch(/box-shadow/);
    const input = rule('.search-field input[type=search]');
    for (const d of ['-webkit-appearance:none', 'appearance:none', 'border:0', 'box-shadow:none', 'outline:none', 'width:auto', 'min-width:0']) expect(input, d).toContain(d); // anula width:100%, borda e aparência nativa
    expect(rule('.search-field input[type=search]:focus-visible')).toMatch(/outline:none/); // o contorno global de foco não desenha uma segunda borda interna
  });
  it('esconde o botão de limpar NATIVO (WebKit/Blink e Edge/IE): o único "x" é o do aplicativo', () => {
    expect(css).toMatch(/::-webkit-search-cancel-button[^{]*\{[^}]*display:none/);
    expect(css).toMatch(/::-webkit-search-decoration/); expect(css).toMatch(/::-ms-clear[^{]*\{[^}]*display:none/);
  });
  it('o "Fechar" fica fora do campo e não encolhe; o campo ocupa uma linha própria', () => {
    expect(rule('.search-close')).toMatch(/flex-shrink:0/); expect(rule('.search-row')).toMatch(/flex:1 1 100%/);
    expect(css).not.toContain('.search-box'); // estrutura antiga (tudo dentro de uma caixa)
  });
  it('em telas estreitas as duas colunas da página não alargam além da tela (minmax(0,1fr))', () => {
    expect(css).toMatch(/@media\(max-width:700px\)\{[^@]*\.two\{grid-template-columns:minmax\(0,1fr\)\}/); expect(rule('.two>*')).toContain('min-width:0');
  });
  it('o texto do campo tem 16 px (o iOS não amplia a tela ao focar) e os botões têm alvo de toque confortável', () => {
    expect(rule('.search-field input[type=search]')).toContain('font-size:16px');
    expect(rule('.search-toggle')).toContain('min-height:44px'); expect(rule('.search-close')).toContain('min-height:44px');
  });
});
