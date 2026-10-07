import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, uploadFile } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { ErrorState } from '../../components/ErrorState';

interface Customer {
  id: string;
  name: string;
  priceListId: string | null;
}
interface PriceListRef {
  id: string;
  code: string;
  name: string;
  role: 'main' | 'general' | null;
}
interface Product {
  id: string;
  sku: string;
  name: string;
  status: string;
  unitPrice: string;
}
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
  status: string;
}
interface Line {
  productId: string;
  quantity: number;
  discountAmount: string;
  repPrice: string;
  managerPrice: string;
}
interface AvailableCredit {
  id: string;
  returnNumber: string | null;
  originalSalesOrderId: string;
  productId: string;
  quantity: number;
  returnType: 'exchange' | 'value_credit' | 'product_return' | null;
  remainingAmount: string;
}

const emptyLine = (): Line => ({ productId: '', quantity: 1, discountAmount: '0', repPrice: '', managerPrice: '' });

export function SalesOrdersCreate() {
  const { can } = useAuth();
  const canSetManagerPrice = can('wf.sales.order.set_manager_price', 'editable');
  const { t, preload } = useLanguage();
  preload([
    'nav.sales_orders',
    'field.customer',
    'field.product',
    'field.quantity',
    'field.discount_amount',
    'field.price_list_applied',
    'field.no_override',
    'field.list_price',
    'field.price_list_price',
    'field.rep_price',
    'field.manager_price',
    'field.line_total',
    'field.sales_rep',
    'field.warehouse',
    'field.select_warehouse',
    'field.shipping_method',
    'shipping_method.company_vehicles',
    'shipping_method.shipping_company',
    'field.available_stock',
    'field.total_items',
    'field.total_discount',
    'field.total_price',
    'validation.insufficient_stock',
    'action.save',
    'action.cancel',
    'action.add_line',
    'panel.deposit_at_order_creation',
    'field.skip_deposit',
    'field.deposit_amount',
    'field.method',
    'method.bank_transfer',
    'method.cash',
    'method.wallet',
    'method.card',
    'field.reference',
    'field.deposit_receipt',
    'action.upload_receipt',
    'error.order_created_deposit_failed',
    'error.order_created_credit_apply_failed',
    'panel.returns_credits',
    'panel.no_available_credits',
    'field.return_number',
    'field.original_order',
    'field.return_type',
    'field.credit_value',
    'return_type.exchange',
    'return_type.value_credit',
    'return_type.product_return',
    'action.apply_credit',
    'field.subtotal',
    'field.return_credit_applied',
    'field.net_total',
  ]);
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [priceLists, setPriceLists] = useState<PriceListRef[]>([]);
  const [priceListItems, setPriceListItems] = useState<Map<string, string>>(new Map());
  // Hotfix 3 (post-v1.0.2) — the Main/General tiers of the price-list
  // priority chain, previewed the same way the customer-list tier already
  // was: fetched once (Main/General don't depend on which customer is
  // selected), consulted client-side in the same order the server
  // authoritatively applies at submit time.
  const [mainListItems, setMainListItems] = useState<Map<string, string>>(new Map());
  const [generalListItems, setGeneralListItems] = useState<Map<string, string>>(new Map());
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [shippingMethod, setShippingMethod] = useState<'' | 'company_vehicles' | 'shipping_company'>('');
  const [stockByKey, setStockByKey] = useState<Map<string, number>>(new Map());
  const [reps, setReps] = useState<AdminUser[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [salesRepUserId, setSalesRepUserId] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  // Hotfix 6 (post-v1.0.2) — "إنشاء بدون عربون". When checked, the deposit
  // fields below are hidden and never submitted; the order still goes
  // through Supervisor -> Manager approval unchanged, it just never enters
  // the Finance deposit-approval step (see backend `transitionOrder`).
  const [skipDeposit, setSkipDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositMethod, setDepositMethod] = useState('bank_transfer');
  const [depositReference, setDepositReference] = useState('');
  const [depositFile, setDepositFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // Returns Engine (CTO directive §6) — the customer's active Return Credits, shown below the line items.
  const [availableCredits, setAvailableCredits] = useState<AvailableCredit[]>([]);
  const [selectedCreditIds, setSelectedCreditIds] = useState<Set<string>>(new Set());
  const [creditOrderNumbers, setCreditOrderNumbers] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [p, pl, wh] = await Promise.all([
          api.get<Product[]>('/products'),
          api.get<PriceListRef[]>('/price-lists'),
          api.get<Warehouse[]>('/inventory/warehouses'),
        ]);
        setProducts(p.filter((prod) => prod.status === 'active'));
        setPriceLists(pl);
        setWarehouses(wh);

        // Hotfix 3 (post-v1.0.2) — Main/General tier items for the preview,
        // fetched once here (unlike the customer-list tier below, these
        // don't change with which customer is selected).
        const mainList = pl.find((x) => x.role === 'main');
        const generalList = pl.find((x) => x.role === 'general');
        if (mainList) {
          const items = await api.get<Array<{ productId: string; price: string }>>(`/price-lists/${mainList.id}/items`);
          setMainListItems(new Map(items.map((i) => [i.productId, i.price])));
        }
        if (generalList) {
          const items = await api.get<Array<{ productId: string; price: string }>>(`/price-lists/${generalList.id}/items`);
          setGeneralListItems(new Map(items.map((i) => [i.productId, i.price])));
        }
        const firstActive = wh.find((w) => w.status === 'active');
        if (firstActive) setWarehouseId(firstActive.id);
        // CTO instruction: a manager MAY build/adjust an order under a
        // different rep's name (the only way a managerPrice can ever be
        // set — see SalesOrdersService.createOrder). Reps themselves never
        // see this selector; their own order is implicit (server defaults
        // to the caller when salesRepUserId is omitted). `/admin/sales-reps`
        // (not `/admin/users`) — narrower on purpose: only sales_rep
        // holders, not the whole user table.
        if (canSetManagerPrice) {
          const salesReps = await api.get<AdminUser[]>('/admin/sales-reps');
          setReps(salesReps);
        }
      } catch (err) {
        // Foundation fix: this load had no error handling at all — a
        // failure here left the form silently unusable (empty selects,
        // no explanation) instead of a real Error state.
        setLoadError(err);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CTO directive (Priority 1 — customer visibility by Sales
  // Representative): when a manager picks a specific rep, the customer
  // list narrows to ONLY that rep's assigned customers — server-enforced
  // in CustomersService.listCustomersForRep, this is just wiring the
  // selector to it. A plain rep never sees the selector, so this always
  // fetches with no filter for them (their own Scope-filtered list,
  // unchanged from before).
  useEffect(() => {
    (async () => {
      try {
        const qs = salesRepUserId ? `?salesRepUserId=${salesRepUserId}` : '';
        const c = await api.get<Customer[]>(`/customers${qs}`);
        setCustomers(c);
        setCustomerId((prev) => (c.some((x) => x.id === prev) ? prev : ''));
      } catch (err) {
        setLoadError(err);
      }
    })();
  }, [salesRepUserId]);

  // Returns Engine (CTO directive §6) — fetch the customer's active credits whenever the customer changes; never carried over from a previous selection.
  useEffect(() => {
    setSelectedCreditIds(new Set());
    if (!customerId) {
      setAvailableCredits([]);
      return;
    }
    (async () => {
      const creditsData = await api.get<AvailableCredit[]>(`/returns/credits?customerId=${customerId}`);
      setAvailableCredits(creditsData);

      // "Original SO" (directive §6) — resolve to the real order number for display, not a raw id. Small, distinct N — same "N calls fine at V1 scale" precedent used elsewhere.
      const distinctOrderIds = [...new Set(creditsData.map((c) => c.originalSalesOrderId))];
      const entries = await Promise.all(
        distinctOrderIds.map(async (id) => {
          try {
            const order = await api.get<{ orderNumber: string }>(`/sales-orders/${id}`);
            return [id, order.orderNumber] as const;
          } catch {
            return [id, id] as const;
          }
        }),
      );
      setCreditOrderNumbers(Object.fromEntries(entries));
    })();
  }, [customerId]);

  function toggleCredit(id: string) {
    setSelectedCreditIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCustomer = customers.find((c) => c.id === customerId);
  const appliedPriceList = selectedCustomer?.priceListId
    ? priceLists.find((pl) => pl.id === selectedCustomer.priceListId)
    : null;

  // Fetches the customer's assigned Price List's actual item overrides —
  // REAL BUG FOUND LIVE (CTO directive, Priority 3): the preview used to
  // always start from the product's raw base price, silently ignoring
  // any Price List override, so a rep could see one number here and get
  // charged a completely different one at save time (e.g. a line
  // resolving to 8.00 against a 150.00 base with no warning at all).
  useEffect(() => {
    (async () => {
      if (!selectedCustomer?.priceListId) {
        setPriceListItems(new Map());
        return;
      }
      const items = await api.get<Array<{ productId: string; price: string }>>(
        `/price-lists/${selectedCustomer.priceListId}/items`,
      );
      setPriceListItems(new Map(items.map((i) => [i.productId, i.price])));
    })();
  }, [selectedCustomer?.priceListId]);

  // CTO directive (Priority 2 — stock availability): live available-stock
  // lookup per (warehouse, product) so the rep sees it BEFORE saving, not
  // after a server rejection. Cached by key — switching back to an
  // already-seen product/warehouse combo doesn't re-fetch.
  useEffect(() => {
    if (!warehouseId) return;
    const productIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
    const missing = productIds.filter((pid) => !stockByKey.has(`${warehouseId}:${pid}`));
    if (missing.length === 0) return;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (pid) => {
          const res = await api.get<{ onHand: number; reserved: number; available: number }>(
            `/inventory/stock?warehouseId=${warehouseId}&productId=${pid}`,
          );
          return [`${warehouseId}:${pid}`, res.available] as const;
        }),
      );
      setStockByKey((prev) => new Map([...prev, ...entries]));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, lines.map((l) => l.productId).join(',')]);

  function availableStockForLine(line: Line): number | null {
    if (!warehouseId || !line.productId) return null;
    return stockByKey.get(`${warehouseId}:${line.productId}`) ?? null;
  }

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * Client-side PREVIEW only, mirroring the server's own precedence
   * (managerPrice > repPrice > Price-List-resolved price > base price)
   * purely so the rep sees the item total as they type — the server
   * re-derives every number from scratch at submit time and never trusts
   * this (ADR-008). `priceListPrice` now comes from the SAME
   * Customer -> Main -> General chain the server authoritatively applies
   * (Hotfix 3, post-v1.0.2) — not just the customer's own list — so the
   * preview stops silently under-representing the Main/General tiers.
   */
  function previewForLine(line: Line) {
    const product = products.find((p) => p.id === line.productId);
    const listPrice = product ? Number(product.unitPrice) : 0;
    const resolvedOverride =
      priceListItems.get(line.productId) ?? mainListItems.get(line.productId) ?? generalListItems.get(line.productId);
    const priceListPrice = resolvedOverride !== undefined ? Number(resolvedOverride) : listPrice;
    const managerPrice = canSetManagerPrice && line.managerPrice ? Number(line.managerPrice) : null;
    const repPrice = line.repPrice ? Number(line.repPrice) : null;
    const appliedPrice = managerPrice ?? repPrice ?? priceListPrice;
    const discountAmount = Number(line.discountAmount || '0');
    const lineTotal = Math.max(0, appliedPrice * line.quantity - discountAmount);
    const variance = appliedPrice - listPrice;
    return { listPrice, priceListPrice, appliedPrice, lineTotal, variance };
  }

  const validLines = lines.filter((l) => l.productId && l.quantity > 0);
  const totals = validLines.reduce(
    (acc, l) => {
      const p = previewForLine(l);
      acc.itemCount += l.quantity;
      acc.totalDiscount += Number(l.discountAmount || '0') + Math.max(0, -p.variance) * l.quantity;
      acc.totalPrice += p.lineTotal;
      return acc;
    },
    { itemCount: 0, totalDiscount: 0, totalPrice: 0 },
  );

  const hasStockError = validLines.some((l) => {
    const available = availableStockForLine(l);
    return available !== null && l.quantity > available;
  });

  // Returns Engine (CTO directive §6) — "Subtotal - Return Credit = Net
  // Total," pure display arithmetic; the order's own totalAmount is never
  // touched (see plan reconciliation). Each selected credit is applied up
  // to whatever of the subtotal remains unabsorbed, in selection order —
  // a credit worth more than what's left of the order is simply applied
  // PARTIALLY (never wasted, never over-applied); every individual apply
  // call is still independently validated server-side regardless.
  const creditApplications = (() => {
    let remainingSubtotal = totals.totalPrice;
    const applications: Array<{ creditId: string; amount: number }> = [];
    for (const credit of availableCredits) {
      if (!selectedCreditIds.has(credit.id) || remainingSubtotal <= 0) continue;
      const amount = Math.min(Number(credit.remainingAmount), remainingSubtotal);
      if (amount <= 0) continue;
      applications.push({ creditId: credit.id, amount });
      remainingSubtotal -= amount;
    }
    return applications;
  })();
  const totalCreditApplied = creditApplications.reduce((sum, a) => sum + a.amount, 0);
  const netTotal = Math.max(0, totals.totalPrice - totalCreditApplied);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (hasStockError) return; // UI already shows the per-line reason; never let this reach the server
    setBusy(true);
    try {
      const order = await api.post<{ id: string }>('/sales-orders', {
        customerId,
        warehouseId,
        shippingMethod,
        ...(salesRepUserId ? { salesRepUserId } : {}),
        ...(skipDeposit ? { skipDeposit: true } : {}),
        lines: validLines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          discountAmount: l.discountAmount || '0',
          ...(l.repPrice ? { repPrice: l.repPrice } : {}),
          ...(canSetManagerPrice && l.managerPrice ? { managerPrice: l.managerPrice } : {}),
        })),
      });

      // Deposit is a separate domain (Deposit Control), never baked into
      // order creation itself — this just calls its existing endpoint
      // right after, so the rep can record "the customer already sent
      // this" in one screen. The order itself is never rolled back if
      // this fails; instead we stop short of navigating away and tell
      // the rep plainly, since the order's own Detail screen
      // (DepositPanel) is still there as a fallback to submit it from.
      if (!skipDeposit && depositAmount.trim()) {
        try {
          let evidenceMediaAssetId: string | undefined;
          if (depositFile) {
            const asset = await uploadFile<{ id: string }>('/media/upload', depositFile);
            evidenceMediaAssetId = asset.id;
          }
          await api.post('/deposits', {
            salesOrderId: order.id,
            amount: depositAmount,
            method: depositMethod,
            ...(depositReference.trim() ? { reference: depositReference.trim() } : {}),
            ...(evidenceMediaAssetId ? { evidenceMediaAssetId } : {}),
          });
        } catch (depositErr) {
          setBusy(false);
          setError(
            `${t('error.order_created_deposit_failed')} ${depositErr instanceof ApiError ? depositErr.message : ''}`.trim(),
          );
          return;
        }
      }

      // Returns Engine (CTO directive §6) — apply any selected credits
      // right after order creation, same "secondary call after creation"
      // precedent the deposit panel above already uses. The order itself
      // is not rolled back if this fails; the rep can still apply credits
      // later from the order's own screen.
      for (const application of creditApplications) {
        try {
          await api.post(`/returns/credits/${application.creditId}/apply`, {
            salesOrderId: order.id,
            amount: application.amount.toFixed(2),
          });
        } catch {
          // Non-fatal — the order already exists; surfaced via a soft error, not a blocked navigation.
          setError(t('error.order_created_credit_apply_failed'));
        }
      }

      navigate(`/sales-orders/${order.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create order.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('nav.sales_orders')}</h1>
        </div>
        <div className="empty-state">Loading…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('nav.sales_orders')}</h1>
        </div>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.sales_orders')}</h1>
      </div>
      <div className="card" style={{ maxWidth: 960 }}>
        <form onSubmit={onSubmit}>
          {canSetManagerPrice && (
            <div className="form-field">
              <label>{t('field.sales_rep')}</label>
              <select value={salesRepUserId} onChange={(e) => setSalesRepUserId(e.target.value)}>
                <option value="">—</option>
                {reps.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="form-field">
            <label>{t('field.warehouse')}</label>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
              <option value="" disabled>
                {t('field.select_warehouse')}
              </option>
              {warehouses
                .filter((w) => w.status === 'active')
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
            </select>
          </div>

          <div className="form-field">
            <label>{t('field.shipping_method')}</label>
            <select
              value={shippingMethod}
              onChange={(e) => setShippingMethod(e.target.value as 'company_vehicles' | 'shipping_company')}
              required
            >
              <option value="" disabled>
                —
              </option>
              <option value="company_vehicles">{t('shipping_method.company_vehicles')}</option>
              <option value="shipping_company">{t('shipping_method.shipping_company')}</option>
            </select>
          </div>

          <div className="form-field">
            <label>{t('field.customer')}</label>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="" disabled>
                —
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {customerId && (
              <div style={{ fontSize: '0.82rem', color: '#6b7280', marginTop: 4 }}>
                {t('field.price_list_applied')}:{' '}
                {appliedPriceList ? `${appliedPriceList.code} — ${appliedPriceList.name}` : t('field.no_override')}
              </div>
            )}
          </div>

          {lines.map((line, i) => {
            const preview = previewForLine(line);
            const available = availableStockForLine(line);
            const stockShort = available !== null && line.quantity > available;
            return (
              <div key={i} className="card" style={{ marginBottom: 10, padding: 12 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-field" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
                    <label>{t('field.product')}</label>
                    <select value={line.productId} onChange={(e) => updateLine(i, { productId: e.target.value })} required>
                      <option value="" disabled>
                        —
                      </option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} ({p.unitPrice})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field" style={{ width: 90, marginBottom: 0 }}>
                    <label>{t('field.quantity')}</label>
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                      style={stockShort ? { borderColor: '#a3262d' } : undefined}
                      required
                    />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.available_stock')}</label>
                    <input value={line.productId ? (available !== null ? available : '…') : '—'} readOnly disabled />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.price_list_price')}</label>
                    <input value={line.productId ? preview.priceListPrice.toFixed(2) : '—'} readOnly disabled />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.rep_price')}</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder={t('field.no_override')}
                      value={line.repPrice}
                      onChange={(e) => updateLine(i, { repPrice: e.target.value })}
                    />
                  </div>
                  {canSetManagerPrice && (
                    <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                      <label>{t('field.manager_price')}</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder={t('field.no_override')}
                        value={line.managerPrice}
                        onChange={(e) => updateLine(i, { managerPrice: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.discount_amount')}</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.discountAmount}
                      onChange={(e) => updateLine(i, { discountAmount: e.target.value })}
                    />
                  </div>
                  <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                    <label>{t('field.line_total')}</label>
                    <input value={line.productId ? preview.lineTotal.toFixed(2) : '—'} readOnly disabled />
                  </div>
                  {lines.length > 1 && (
                    <button type="button" className="btn btn-secondary" onClick={() => removeLine(i)}>
                      ×
                    </button>
                  )}
                </div>
                {stockShort && (
                  <div className="error-text" style={{ fontSize: '0.8rem', marginTop: 6 }}>
                    {t('validation.insufficient_stock')
                      .replace('{requested}', String(line.quantity))
                      .replace('{available}', String(available))
                      .replace('{shortfall}', String(line.quantity - (available ?? 0)))}
                  </div>
                )}
              </div>
            );
          })}

          <button type="button" className="btn btn-secondary" onClick={addLine} style={{ marginBottom: 16 }}>
            + {t('action.add_line')}
          </button>

          {/* Returns Engine (CTO directive §6) — a separate section, never a normal order line, matching "الـReturn ليس Sales Order Line عاديًا". */}
          {customerId && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>{t('panel.returns_credits')}</h3>
              {availableCredits.length === 0 ? (
                <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>{t('panel.no_available_credits')}</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>{t('field.return_number')}</th>
                      <th>{t('field.original_order')}</th>
                      <th>{t('field.product')}</th>
                      <th>{t('field.return_type')}</th>
                      <th>{t('field.quantity')}</th>
                      <th>{t('field.credit_value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availableCredits.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <input type="checkbox" checked={selectedCreditIds.has(c.id)} onChange={() => toggleCredit(c.id)} />
                        </td>
                        <td>{c.returnNumber ?? '—'}</td>
                        <td>{creditOrderNumbers[c.originalSalesOrderId] ?? c.originalSalesOrderId}</td>
                        <td>{products.find((p) => p.id === c.productId)?.sku ?? c.productId}</td>
                        <td>{c.returnType ? t(`return_type.${c.returnType}`) : '—'}</td>
                        <td>{c.quantity}</td>
                        <td>{c.remainingAmount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="detail-grid" style={{ marginBottom: 16 }}>
            <div className="detail-field">
              <div className="label">{t('field.total_items')}</div>
              <div className="value">{totals.itemCount}</div>
            </div>
            <div className="detail-field">
              <div className="label">{t('field.total_discount')}</div>
              <div className="value">{totals.totalDiscount.toFixed(2)}</div>
            </div>
            <div className="detail-field">
              <div className="label">{t('field.subtotal')}</div>
              <div className="value">{totals.totalPrice.toFixed(2)}</div>
            </div>
            {totalCreditApplied > 0 && (
              <>
                <div className="detail-field">
                  <div className="label">{t('field.return_credit_applied')}</div>
                  <div className="value">− {totalCreditApplied.toFixed(2)}</div>
                </div>
                <div className="detail-field">
                  <div className="label">{t('field.net_total')}</div>
                  <div className="value">{netTotal.toFixed(2)}</div>
                </div>
              </>
            )}
          </div>

          <div className="card" style={{ marginBottom: 16, background: '#f9fafb' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: skipDeposit ? 0 : 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={skipDeposit} onChange={(e) => setSkipDeposit(e.target.checked)} />
              {t('field.skip_deposit')}
            </label>
            {!skipDeposit && (
              <>
                <h3 style={{ marginTop: 0 }}>{t('panel.deposit_at_order_creation')}</h3>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="form-field" style={{ marginBottom: 0 }}>
                    <label>{t('field.deposit_amount')}</label>
                    <input type="number" min="0" step="0.01" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
                  </div>
                  <div className="form-field" style={{ marginBottom: 0 }}>
                    <label>{t('field.method')}</label>
                    <select value={depositMethod} onChange={(e) => setDepositMethod(e.target.value)}>
                      <option value="bank_transfer">{t('method.bank_transfer')}</option>
                      <option value="cash">{t('method.cash')}</option>
                      <option value="wallet">{t('method.wallet')}</option>
                      <option value="card">{t('method.card')}</option>
                    </select>
                  </div>
                  <div className="form-field" style={{ marginBottom: 0 }}>
                    <label>{t('field.reference')}</label>
                    <input value={depositReference} onChange={(e) => setDepositReference(e.target.value)} />
                  </div>
                  <div className="form-field" style={{ marginBottom: 0 }}>
                    <label>{t('field.deposit_receipt')}</label>
                    <input type="file" accept="image/*,.pdf" onChange={(e) => setDepositFile(e.target.files?.[0] ?? null)} />
                  </div>
                </div>
              </>
            )}
          </div>

          {error && <div className="error-text">{error}</div>}

          <div className="action-row">
            <button className="btn btn-primary" type="submit" disabled={busy || hasStockError || !warehouseId || !shippingMethod}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => navigate('/sales-orders')}>
              {t('action.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
