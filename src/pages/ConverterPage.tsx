import { MeasurementConverter } from '../features/measurement/components/MeasurementConverter';
import { cupSizeOf, withSettings, type PageProps } from '../utils';

export function ConverterPage({ data, update }: PageProps) {
  return <>
    <div className="head"><div><div className="eyebrow">Ferramenta</div><h1>Conversor de medidas</h1><p className="muted">Converta entre gramas, mililitros, xícaras, colheres e unidades. Para passar de peso para volume, escolha um ingrediente: o app usa medidas de referência e funciona sem internet.</p></div></div>
    <section className="card" style={{ maxWidth: 560 }}>
      <MeasurementConverter ingredients={data.ingredients} cupSizeMl={cupSizeOf(data)} onCupSizeChange={n => update(d => withSettings(d, { cupSizeMl: n }))} />
    </section>
    <p className="footnote">Xícara e colheres são convenções culinárias, não medidas físicas exatas. O tamanho da xícara escolhido vale para todo o app, incluindo o cálculo das receitas. Pesos de referência: USDA FoodData Central (domínio público).</p>
  </>;
}
