import { BookOpenText, Calculator, ClipboardList } from 'lucide-react';

const benefits = [
  { icon: Calculator, text: 'Calcule o custo e o preço certo.' },
  { icon: BookOpenText, text: 'Organize suas receitas e fichas técnicas.' },
  { icon: ClipboardList, text: 'Gerencie encomendas e orçamentos.' },
];

/** Apresentação da marca na entrada. As duas imagens são os SVGs originais do Custô. */
export function BrandPanel() {
  return <aside className="auth-brand" aria-label="Conheça o Custô">
    <img className="auth-watermark" src="/brand/favicon-custo-white.svg" alt="" aria-hidden="true" />
    <div className="auth-brand-content">
      <img className="auth-logo" src="/brand/custo-color.svg" alt="Custô" />
      <div className="auth-brand-message">
        <h2>Precificação, receitas, encomendas e orçamentos <span>em um só lugar.</span></h2>
        <ul className="auth-benefits">
          {benefits.map(({ icon: Icon, text }) => <li key={text}><span className="auth-benefit-icon"><Icon size={20} aria-hidden="true" /></span><span>{text}</span></li>)}
        </ul>
      </div>
      <p className="auth-slogan">Seu custo na ponta do lápis. Seu lucro na mão.</p>
    </div>
    <svg className="auth-brand-waves" viewBox="0 0 1000 130" preserveAspectRatio="none" aria-hidden="true">
      <path className="auth-wave-teal" d="M450 130 C590 95 700 35 830 0 C900 4 955 19 1000 32 V130 Z" />
      <path className="auth-wave-coral" d="M0 18 C110 -2 175 0 300 38 C430 77 515 120 650 130 H0 Z" />
    </svg>
  </aside>;
}
