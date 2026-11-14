import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { orderPackagingTotal } from '../../domain/orderCost';
import { calculateOrderFinancials, itemSubtotal } from '../../domain/orderFinancials';
import { isMoney, isPositiveQuantity, parseMoneyInput, toCents2 } from '../../domain/money';
import { money } from '../../domain/pricing';
import { totalReceived } from '../../domain/payments';
import { createOrder, ORDER_ITEM_LIMIT, updateOrder, type OrderItemDraft } from '../../domain/orders';
import type { Order, OrderItem, OrderPackagingSnapshot } from '../../domain/types';
import { Field } from '../../components/Field';
import { MoneyInput } from '../../components/MoneyInput';
import { suggestPackagingQuantity } from '../../domain/packaging';
import { newId, parse, priceRecipe, tryApply, type PageProps } from '../../utils';
import { effectiveQuoteCodes, uniqueQuoteCode } from '../../../shared/quoteCode';

type Props = PageProps & { initialOrder?: Order; onCancel?: () => void; onSaved?: (order: Order) => void };
const parseAmount = (value: string) => parseMoneyInput(value);
/** Linha do formulário. `id` = item já registrado na encomenda (mantém custo e nome históricos se a receita não mudar). */
type ItemRow = { key: string; id?: string; recipeId: string; qty: string; price: string };
const rowOf = (item?: OrderItem): ItemRow => ({ key: item?.id ?? newId(), ...(item ? { id: item.id } : {}), recipeId: item?.recipeId ?? '', qty: item ? String(item.quantity) : '1', price: item ? String(item.unitPrice) : '' });

function makePackageSnapshot(packagingId: string, quantity: number, data: PageProps['data']): OrderPackagingSnapshot | undefined {
  const item = data.packagings.find(p => p.id === packagingId);
  return item ? { packagingId: item.id, name: item.name, quantity, unitCost: item.purchasePrice / item.purchaseQuantity } : undefined;
}

export function OrderForm({ data, update, inform, initialOrder, onCancel, onSaved }: Props) {
  const [customer, setCustomer] = useState(initialOrder?.customer ?? '');
  const [rows, setRows] = useState<ItemRow[]>(() => initialOrder ? initialOrder.items.map(rowOf) : [rowOf()]);
  const [deposit, setDeposit] = useState(initialOrder?.deposit ? String(initialOrder.deposit) : '');
  const [date, setDate] = useState(initialOrder?.deliveryDate ?? '');
  const [extraPackaging, setExtraPackaging] = useState<OrderPackagingSnapshot[]>(initialOrder?.packagingItems ?? []);
  const [packagingDirty, setPackagingDirty] = useState(false);
  const isEditing = !!initialOrder;

  const depositValue = parseAmount(deposit) ?? 0;
  const packageCost = orderPackagingTotal({ packagingItems: extraPackaging });
  const calculatedCharge = toCents2(packageCost);
  // Older orders have no frozen charge. Editing other fields keeps that historical total at product price.
  const packagingCharge = initialOrder && !packagingDirty ? initialOrder.packagingCharge ?? 0 : calculatedCharge;
  const existingReceivedPayments = (initialOrder?.payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  const totalReceivedBeforeSave = initialOrder ? toCents2(depositValue + existingReceivedPayments) : depositValue;
  const priced = useMemo(() => new Map(data.recipes.map(r => [r.id, priceRecipe(r, data)])), [data]);
  /** Custo unitário de cada linha: o congelado no item (edição, mesma receita) ou o atual da receita (item novo). */
  const rowCost = (row: ItemRow): number | undefined => {
    const previous = row.id ? initialOrder?.items.find(item => item.id === row.id) : undefined;
    if (previous && previous.recipeId === row.recipeId && previous.costSnapshot) return previous.costSnapshot.costPerUnit;
    const p = priced.get(row.recipeId);
    return p?.ok ? p.cost.costPerUnitExact : undefined;
  };
  const financials = calculateOrderFinancials({
    items: rows.map(row => {
      const quantity = parse(row.qty), price = parseAmount(row.price), cost = row.recipeId ? rowCost(row) : undefined;
      return { quantity: isPositiveQuantity(quantity) ? quantity : 0, unitPrice: isMoney(price) ? price : 0, ...(cost !== undefined ? { costPerUnit: cost } : {}) };
    }),
    packagingCharge,
    additionalPackagingCost: packageCost,
    received: totalReceivedBeforeSave,
  });
  const chosen = new Set(rows.map(row => row.recipeId).filter(Boolean));
  const selectedRecipes = data.recipes.filter(r => chosen.has(r.id));
  const singleQuantity = rows.length === 1 ? parse(rows[0].qty) : undefined;
  /** Capacidade só sugere quantidade com UM produto: caixas não comportam automaticamente produtos diferentes misturados. */
  const suggestedCount = (capacity: number | undefined, fallback: number) => capacity && singleQuantity !== undefined && isPositiveQuantity(singleQuantity) ? suggestPackagingQuantity(singleQuantity, capacity) : fallback;
  const willConfirm = depositValue > 0 && (!initialOrder || (initialOrder.status === 'Orçamento' && toCents2(depositValue) > initialOrder.deposit));

  function setRow(key: string, patch: Partial<ItemRow>) { setRows(list => list.map(row => (row.key === key ? { ...row, ...patch } : row))); }
  function setProduct(key: string, nextId: string) {
    const current = rows.find(row => row.key === key);
    const previous = current?.id ? initialOrder?.items.find(item => item.id === current.id) : undefined;
    // Preço negociado de um item já registrado é mantido; item novo começa com o preço sugerido da receita.
    if (previous) return setRow(key, { recipeId: nextId });
    const suggested = priced.get(nextId);
    setRow(key, { recipeId: nextId, price: suggested?.ok ? String(suggested.cost.suggestedPrice) : '' });
  }
  function addRow() { setRows(list => (list.length >= ORDER_ITEM_LIMIT ? list : [...list, rowOf()])); }
  function removeRow(key: string) { setRows(list => (list.length <= 1 ? list : list.filter(row => row.key !== key))); }

  function addPackaging() {
    const item = data.packagings.find(p => p.active && !extraPackaging.some(x => x.packagingId === p.id));
    if (!item) return;
    const snapshot = makePackageSnapshot(item.id, suggestedCount(item.capacity, 1), data);
    if (snapshot) { setPackagingDirty(true); setExtraPackaging(list => [...list, snapshot]); }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const depositParsed = parseAmount(deposit);
    if (depositParsed !== undefined && !isMoney(depositParsed)) { inform('Revise o sinal. Ele é opcional e não pode superar o total.'); return; }
    const items: OrderItemDraft[] = rows.map(row => ({ ...(row.id ? { id: row.id } : {}), recipeId: row.recipeId, quantity: parse(row.qty), unitPrice: parseAmount(row.price) ?? Number.NaN }));
    const sinal = depositParsed ?? 0;
    if (initialOrder) {
      let saved: Order | undefined;
      const failed = tryApply(data, update, d => { const next = updateOrder(d, initialOrder.id, { customer, items, deliveryDate: date, deposit: sinal, packagingItems: extraPackaging, packagingCharge }); saved = next.orders.find(o => o.id === initialOrder.id); return next; });
      if (failed) return inform(failed);
      const confirmed = saved?.status === 'Confirmado' && initialOrder.status === 'Orçamento';
      onSaved?.(saved!); inform(confirmed ? 'Encomenda atualizada e confirmada pelo sinal recebido.' : 'Encomenda atualizada. Status, recebimentos e data de criação foram mantidos.'); return;
    }
    let order: Order;
    try {
      order = createOrder(data, { customer, items, deliveryDate: date, deposit: sinal, packagingItems: extraPackaging },
        { id: newId(), quoteCode: uniqueQuoteCode(new Set(effectiveQuoteCodes(data.orders).values())) });
    } catch (error) { inform(error instanceof Error ? error.message : 'Revise os dados da encomenda.'); return; }
    update(d => ({ ...d, orders: [...d.orders, order] }));
    inform(order.status === 'Confirmado' ? 'Encomenda cadastrada e confirmada pelo sinal recebido.' : 'Encomenda cadastrada.'); onSaved?.(order);
  }

  return <form className="stack order-form" onSubmit={save}>
    <section className="order-form-section" aria-labelledby="order-data-heading">
      <h2 id="order-data-heading" className="section-title">1. Dados da encomenda</h2>
      <div className="form-grid order-form-grid">
        <Field label="Nome do cliente"><input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Ex.: Ana Martins" required /></Field>
        <Field label="Data de entrega"><input type="date" value={date} onChange={e => setDate(e.target.value)} required /></Field>
      </div>
      <h3 className="order-items-title">Produtos</h3>
      <ul className="order-items" aria-label="Produtos da encomenda">
        {rows.map((row, index) => {
          const recipe = data.recipes.find(r => r.id === row.recipeId);
          const previous = row.id ? initialOrder?.items.find(item => item.id === row.id) : undefined;
          const quantity = parse(row.qty), price = parseAmount(row.price);
          const p = recipe ? priced.get(recipe.id) : undefined;
          return <li className="order-item-row" key={row.key} aria-label={`Produto ${index + 1}`}>
            <Field label="Receita"><select value={row.recipeId} onChange={e => setProduct(row.key, e.target.value)} required>
              <option value="">Escolha a receita...</option>
              {data.recipes.filter(r => r.id === row.recipeId || !chosen.has(r.id)).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              {previous && !recipe && <option value={previous.recipeId}>{previous.recipeName ?? 'Receita indisponível'}</option>}
            </select></Field>
            <Field label="Quantidade"><input type="number" min="0.01" step="any" value={row.qty} onChange={e => setRow(row.key, { qty: e.target.value })} required /></Field>
            <Field label="Preço de venda unitário (R$)"><MoneyInput value={row.price} onValueChange={value => setRow(row.key, { price: value })} required /></Field>
            <div className="order-item-subtotal"><span>Subtotal</span><strong>{money(isPositiveQuantity(quantity) && isMoney(price) ? itemSubtotal({ quantity, unitPrice: price }) : 0)}</strong></div>
            <button type="button" className="inline-icon" aria-label={`Remover produto ${index + 1}`} disabled={rows.length <= 1} onClick={() => removeRow(row.key)}><Trash2 size={16} /></button>
            {p && !p.ok && <div className="notice warn order-item-note"><strong>Custo indisponível.</strong> {p.message} Informe o preço unitário manualmente ou corrija o cadastro.</div>}
            {previous && previous.recipeId === row.recipeId && previous.costSnapshot ? <p className="muted order-item-note">Custo registrado em {previous.costSnapshot.capturedAt.slice(0, 10).split('-').reverse().join('/')} mantido.</p>
              : p?.ok ? <p className="muted order-item-note">Custo estimado: {money(p.cost.costPerUnit)} por unidade.</p> : null}
          </li>;
        })}
      </ul>
      <button className="secondary" type="button" onClick={addRow} disabled={rows.length >= ORDER_ITEM_LIMIT || chosen.size >= data.recipes.length}><Plus size={16} /> Adicionar receita</button>
      <p className="form-subtitle">Cada receita aparece uma vez por encomenda; para mais unidades, aumente a quantidade do item.</p>
    </section>

    <section className="order-form-section" aria-labelledby="order-packaging-heading">
      <h2 id="order-packaging-heading" className="section-title">2. Embalagens</h2>
      {selectedRecipes.length ? <div className="order-packaging-groups">
        <div><h3>Incluídas pelos produtos</h3><p className="form-subtitle">Já fazem parte do custo de cada receita e não são cobradas novamente.</p>
          {selectedRecipes.map(recipe => <div key={recipe.id}><strong className="order-pack-recipe">{recipe.name}</strong>
            {recipe.packagingItems?.length ? recipe.packagingItems.map(item => {
              const pkg = data.packagings.find(p => p.id === item.packagingId);
              return <p className="muted" key={item.packagingId}>{pkg?.name ?? 'Embalagem desativada'} · {item.quantityPerUnit} por unidade</p>;
            }) : <p className="muted">Nenhuma embalagem incluída na receita.</p>}</div>)}
        </div>
        <div><h3>Adicionais da encomenda</h3><p className="form-subtitle">Toda embalagem adicional selecionada será somada ao total cobrado do cliente.</p>
          {extraPackaging.map((entry, index) => <div className="order-package-line" key={`${entry.packagingId}-${index}`}>
            <label><span className="sr-only">Embalagem adicional</span><select aria-label="Embalagem adicional" value={entry.packagingId} onChange={e => {
              const selected = data.packagings.find(p => p.id === e.target.value); if (!selected) return;
              const count = suggestedCount(selected.capacity, entry.quantity);
              const snapshot = makePackageSnapshot(selected.id, count, data); if (!snapshot) return;
              setPackagingDirty(true); setExtraPackaging(list => list.map((x, i) => i === index ? snapshot : x));
            }}>{data.packagings.filter(p => p.active || p.id === entry.packagingId).map(p => <option key={p.id} value={p.id}>{p.name}{selectedRecipes.some(r => r.packagingItems?.some(x => x.packagingId === p.id)) ? ' · também incluída em um produto' : ''}</option>)}</select></label>
            <Field label="Quantidade"><input type="number" min="0.001" step="any" value={entry.quantity} onChange={e => { setPackagingDirty(true); setExtraPackaging(list => list.map((x, i) => i === index ? { ...x, quantity: parse(e.target.value) } : x)); }} /></Field>
            <strong>{money(toCents2(entry.quantity * entry.unitCost))}</strong>
            <button type="button" className="inline-icon" aria-label="Remover embalagem adicional" onClick={() => { setPackagingDirty(true); setExtraPackaging(list => list.filter((_, i) => i !== index)); }}><Trash2 size={16} /></button>
          </div>)}
          <button className="secondary" type="button" onClick={addPackaging} disabled={!data.packagings.some(p => p.active && !extraPackaging.some(x => x.packagingId === p.id))}><Plus size={16} /> Adicionar embalagem adicional</button>
          {rows.length > 1 && <p className="form-subtitle">Com vários produtos, informe manualmente quantas embalagens serão usadas (a capacidade não é aplicada a produtos misturados).</p>}
          {extraPackaging.some(x => selectedRecipes.some(r => r.packagingItems?.some(p => p.packagingId === x.packagingId))) && <p className="notice warn">Uma embalagem adicional também está incluída na receita. A cobrança extra é intencional e será somada ao total.</p>}
        </div>
      </div> : <p className="muted">Selecione uma receita para visualizar as embalagens dos produtos.</p>}
    </section>

    <section className="order-form-section" aria-labelledby="order-summary-heading">
      <h2 id="order-summary-heading" className="section-title">3. Resumo financeiro</h2>
      <div className="order-financial-summary">
        <div><span>Produtos ({rows.length} {rows.length === 1 ? 'item' : 'itens'})</span><strong>{money(financials.productsTotal)}</strong></div>
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
      {willConfirm && <p className="notice info" role="status">Ao registrar este sinal, a encomenda será confirmada automaticamente.</p>}
      {depositValue > 0 && <p className="form-subtitle">O sinal é registrado no pedido como valor já recebido. A edição preserva os demais recebimentos.</p>}
    </section>

    <div className="order-form-actions"><button className="primary" disabled={!data.recipes.length} type="submit"><Save size={17} /> {isEditing ? 'Salvar alterações' : 'Registrar encomenda'}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>}</div>
  </form>;
}
