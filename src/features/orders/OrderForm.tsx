import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { captureCostSnapshot, orderPackagingTotal } from '../../domain/orderCost';
import { calculateOrderFinancials } from '../../domain/orderFinancials';
import { isMoney, isPositiveQuantity, parseMoneyInput, toCents2 } from '../../domain/money';
import { money } from '../../domain/pricing';
import { orderTotal, totalReceived } from '../../domain/payments';
import { updateOrder } from '../../domain/edit';
import type { Order, OrderPackagingSnapshot } from '../../domain/types';
import { Field } from '../../components/Field';
import { MoneyInput } from '../../components/MoneyInput';
import { suggestPackagingQuantity } from '../../domain/packaging';
import { newId, parse, priceRecipe, tryApply, type PageProps } from '../../utils';
import { effectiveQuoteCodes, uniqueQuoteCode } from '../../../shared/quoteCode';

type Props = PageProps & { initialOrder?: Order; onCancel?: () => void; onSaved?: (order: Order) => void };
const parseAmount = (value: string) => parseMoneyInput(value);

function makePackageSnapshot(packagingId: string, quantity: number, data: PageProps['data']): OrderPackagingSnapshot | undefined {
  const item = data.packagings.find(p => p.id === packagingId);
  return item ? { packagingId: item.id, name: item.name, quantity, unitCost: item.purchasePrice / item.purchaseQuantity } : undefined;
}

export function OrderForm({ data, update, inform, initialOrder, onCancel, onSaved }: Props) {
  const [customer, setCustomer] = useState(initialOrder?.customer ?? '');
  const [recipeId, setRecipeId] = useState(initialOrder?.recipeId ?? '');
  const [qty, setQty] = useState(initialOrder ? String(initialOrder.quantity) : '1');
  const [unitPrice, setUnitPrice] = useState(initialOrder ? String(initialOrder.unitPrice) : '');
  const [deposit, setDeposit] = useState(initialOrder?.deposit ? String(initialOrder.deposit) : '');
  const [date, setDate] = useState(initialOrder?.deliveryDate ?? '');
  const [extraPackaging, setExtraPackaging] = useState<OrderPackagingSnapshot[]>(initialOrder?.packagingItems ?? []);
  const [packagingDirty, setPackagingDirty] = useState(false);

  const recipe = data.recipes.find(r => r.id === recipeId);
  const price = parseAmount(unitPrice);
  const quantity = parse(qty);
  const depositValue = parseAmount(deposit) ?? 0;
  const recipePrice = useMemo(() => recipe ? priceRecipe(recipe, data) : null, [recipe, data]);
  const packageCost = orderPackagingTotal({ packagingItems: extraPackaging });
  const calculatedCharge = toCents2(packageCost);
  // Older orders have no frozen charge. Editing other fields keeps that historical total at product price.
  const packagingCharge = initialOrder && !packagingDirty ? initialOrder.packagingCharge ?? 0 : calculatedCharge;
  const existingReceivedPayments = (initialOrder?.payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  const totalReceivedBeforeSave = initialOrder ? toCents2(depositValue + existingReceivedPayments) : depositValue;
  const financials = calculateOrderFinancials({
    quantity: isPositiveQuantity(quantity) ? quantity : 0,
    unitPrice: isMoney(price) ? price : 0,
    packagingCharge,
    recipeCostPerUnit: recipePrice?.ok ? recipePrice.cost.costPerUnitExact : undefined,
    additionalPackagingCost: packageCost,
    received: totalReceivedBeforeSave,
  });
  const isEditing = !!initialOrder;

  function setProduct(nextId: string) {
    setRecipeId(nextId);
    if (isEditing) return; // mantém o preço negociado ao editar
    const next = data.recipes.find(r => r.id === nextId);
    const suggested = next ? priceRecipe(next, data) : null;
    setUnitPrice(suggested?.ok ? String(suggested.cost.suggestedPrice) : '');
  }

  function addPackaging() {
    const item = data.packagings.find(p => p.active && !extraPackaging.some(x => x.packagingId === p.id));
    if (!item) return;
    const count = item.capacity && isPositiveQuantity(quantity) ? suggestPackagingQuantity(quantity, item.capacity) : 1;
    const snapshot = makePackageSnapshot(item.id, count, data);
    if (snapshot) { setPackagingDirty(true); setExtraPackaging(list => [...list, snapshot]); }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const q = parse(qty), unit = parseAmount(unitPrice), depositParsed = parseAmount(deposit);
    const sinal = depositParsed ?? 0;
    if (!customer.trim() || !recipeId || !date || !isPositiveQuantity(q) || !isMoney(unit) || (depositParsed !== undefined && !isMoney(depositParsed)) || sinal > financials.totalCharged) {
      inform('Revise cliente, receita, data, quantidade, preço e sinal. O sinal é opcional e não pode superar o total.'); return;
    }
    const charged = toCents2(orderPackagingTotal({ packagingItems: extraPackaging }));
    const formTotal = orderTotal({ quantity: q, unitPrice: unit, packagingCharge: packagingCharge });
    if (sinal > formTotal) { inform('O sinal não pode ser maior que o total da encomenda.'); return; }

    if (initialOrder) {
      const next = { ...initialOrder, customer: customer.trim(), recipeId, quantity: q, unitPrice: toCents2(unit), deposit: toCents2(sinal), deliveryDate: date, packagingItems: extraPackaging, packagingCharge };
      const failed = tryApply(data, update, d => updateOrder(d, initialOrder.id, { customer, recipeId, quantity: q, unitPrice: unit, deliveryDate: date, deposit: sinal, packagingItems: extraPackaging, packagingCharge }));
      if (failed) return inform(failed);
      onSaved?.(next); inform('Encomenda atualizada. Status, recebimentos e data de criação foram mantidos.'); return;
    }

    const now = new Date();
    const costSnapshot = recipe ? captureCostSnapshot(recipe, data, now) : undefined;
    const order: Order = {
      id: newId(), quoteCode: uniqueQuoteCode(new Set(effectiveQuoteCodes(data.orders).values())),
      customer: customer.trim(), recipeId, quantity: q, unitPrice: toCents2(unit), deliveryDate: date,
      status: 'Orçamento', deposit: toCents2(sinal), createdAt: now.toISOString(),
      packagingItems: extraPackaging, packagingCharge: charged, ...(costSnapshot ? { costSnapshot } : {}),
    };
    update(d => ({ ...d, orders: [...d.orders, order] }));
    inform('Encomenda cadastrada.'); onSaved?.(order);
  }

  return <form className="stack order-form" onSubmit={save}>
    <section className="order-form-section" aria-labelledby="order-data-heading">
      <h2 id="order-data-heading" className="section-title">1. Dados da encomenda</h2>
      <div className="form-grid order-form-grid">
        <Field label="Nome do cliente"><input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Ex.: Ana Martins" required /></Field>
        <Field label="Receita"><select value={recipeId} onChange={e => setProduct(e.target.value)} required><option value="">Escolha a receita...</option>{data.recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Quantidade"><input type="number" min="0.01" step="any" value={qty} onChange={e => setQty(e.target.value)} required /></Field>
        <Field label="Preço de venda unitário (R$)"><MoneyInput value={unitPrice} onValueChange={setUnitPrice} required /></Field>
        <Field label="Data de entrega"><input type="date" value={date} onChange={e => setDate(e.target.value)} required /></Field>
      </div>
      {recipePrice && !recipePrice.ok && <div className="notice warn"><strong>Custo indisponível.</strong> {recipePrice.message} Informe o preço unitário manualmente ou corrija o cadastro.</div>}
      {recipePrice?.ok && <p className="muted">Custo estimado da receita: {money(recipePrice.cost.costPerUnit)} por unidade. O preço de venda pode ser ajustado conforme a negociação.</p>}
    </section>

    <section className="order-form-section" aria-labelledby="order-packaging-heading">
      <h2 id="order-packaging-heading" className="section-title">2. Embalagens</h2>
      {recipe ? <div className="order-packaging-groups">
        <div><h3>Incluídas pelo produto</h3><p className="form-subtitle">Já fazem parte do custo da receita e não são cobradas novamente.</p>
          {recipe.packagingItems?.length ? recipe.packagingItems.map(item => {
            const pkg = data.packagings.find(p => p.id === item.packagingId);
            return <p className="muted" key={item.packagingId}>{pkg?.name ?? 'Embalagem desativada'} · {item.quantityPerUnit} por produto</p>;
          }) : <p className="muted">Nenhuma embalagem incluída na receita.</p>}
        </div>
        <div><h3>Adicionais da encomenda</h3><p className="form-subtitle">Toda embalagem adicional selecionada será somada ao total cobrado do cliente.</p>
          {extraPackaging.map((entry, index) => <div className="order-package-line" key={`${entry.packagingId}-${index}`}>
            <label><span className="sr-only">Embalagem adicional</span><select aria-label="Embalagem adicional" value={entry.packagingId} onChange={e => {
              const selected = data.packagings.find(p => p.id === e.target.value); if (!selected) return;
              const count = selected.capacity && isPositiveQuantity(quantity) ? suggestPackagingQuantity(quantity, selected.capacity) : entry.quantity;
              const snapshot = makePackageSnapshot(selected.id, count, data); if (!snapshot) return;
              setPackagingDirty(true); setExtraPackaging(list => list.map((x, i) => i === index ? snapshot : x));
            }}>{data.packagings.filter(p => p.active || p.id === entry.packagingId).map(p => <option key={p.id} value={p.id}>{p.name}{recipe.packagingItems?.some(x => x.packagingId === p.id) ? ' · também incluída no produto' : ''}</option>)}</select></label>
            <Field label="Quantidade"><input type="number" min="0.001" step="any" value={entry.quantity} onChange={e => { setPackagingDirty(true); setExtraPackaging(list => list.map((x, i) => i === index ? { ...x, quantity: parse(e.target.value) } : x)); }} /></Field>
            <strong>{money(toCents2(entry.quantity * entry.unitCost))}</strong>
            <button type="button" className="inline-icon" aria-label="Remover embalagem adicional" onClick={() => { setPackagingDirty(true); setExtraPackaging(list => list.filter((_, i) => i !== index)); }}><Trash2 size={16} /></button>
          </div>)}
          <button className="secondary" type="button" onClick={addPackaging} disabled={!data.packagings.some(p => p.active && !extraPackaging.some(x => x.packagingId === p.id))}><Plus size={16} /> Adicionar embalagem adicional</button>
          {extraPackaging.some(x => recipe.packagingItems?.some(p => p.packagingId === x.packagingId)) && <p className="notice warn">Uma embalagem adicional também está incluída na receita. A cobrança extra é intencional e será somada ao total.</p>}
        </div>
      </div> : <p className="muted">Selecione uma receita para visualizar as embalagens do produto.</p>}
    </section>

    <section className="order-form-section" aria-labelledby="order-summary-heading">
      <h2 id="order-summary-heading" className="section-title">3. Resumo financeiro</h2>
      <div className="order-financial-summary">
        <div><span>Produtos</span><strong>{money(financials.productsTotal)}</strong></div>
        <div><span>Embalagens adicionais</span><strong>{money(financials.packagingCharge)}</strong></div>
        <div className="order-financial-total"><span>Total cobrado</span><strong>{money(financials.totalCharged)}</strong></div>
        <div><span>Custo estimado total</span><strong>{financials.estimatedCost === undefined ? 'Indisponível' : money(financials.estimatedCost)}</strong></div>
        <div><span>Lucro estimado</span><strong>{financials.estimatedProfit === undefined ? 'Indisponível' : money(financials.estimatedProfit)}</strong></div>
      </div>
      {initialOrder && totalReceived(initialOrder) > financials.totalCharged && <div className="notice error">O total não pode ficar abaixo dos recebimentos já registrados ({money(totalReceived(initialOrder))}).</div>}
    </section>

    <section className="order-form-section" aria-labelledby="order-payment-heading">
      <h2 id="order-payment-heading" className="section-title">4. Pagamento</h2>
      <div className="form-grid order-form-grid">
        <Field label="Sinal recebido (opcional)"><MoneyInput value={deposit} onValueChange={setDeposit} /></Field>
        <div className="order-balance"><span>Saldo restante</span><strong>{money(financials.balanceDue)}</strong></div>
      </div>
      {depositValue > 0 && <p className="form-subtitle">O sinal é registrado no pedido como valor já recebido. A edição preserva os demais recebimentos.</p>}
    </section>

    <div className="order-form-actions"><button className="primary" disabled={!data.recipes.length} type="submit"><Save size={17} /> {isEditing ? 'Salvar alterações' : 'Registrar encomenda'}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>}</div>
  </form>;
}
