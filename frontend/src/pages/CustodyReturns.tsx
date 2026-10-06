import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface CustodyShipmentSearchResult {
  shipmentId: string;
  waybillNumber: string;
  rshNumber: string | null;
  salesOrderId: string;
  salesOrderNumber: string | null;
  customerId: string;
  customerCode: string | null;
  customerName: string | null;
  custodianType: 'company' | 'vehicle';
  custodianId: string;
  custodianName: string;
  custodyWarehouseId: string | null;
  currentCustodyStatus: string;
  items: Array<{ productId: string; quantity: number }>;
}
interface Customer {
  id: string;
  name: string;
  code: string;
}
interface ShippingCompany {
  id: string;
  code: string;
  name: string;
}
interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
}
interface Product {
  id: string;
  sku: string;
}

/**
 * Returns Engine Phase B (CTO directive — "مرتجعات الشحن") — search for
 * goods still sitting in a Shipping Company's or a Company Vehicle's
 * custody (pre-delivery), by Customer/Customer Code/Shipment/Waybill/RSH/
 * Company/Vehicle, then initiate a custody return per product line.
 * Once initiated, the resulting request shows up in the unified Returns
 * list (Returns.tsx) with its own origin badge — inspect/disposition are
 * handled there, unchanged, exactly like a customer return.
 */
export function CustodyReturns() {
  const { t, preload } = useLanguage();
  preload([
    'field.customer',
    'field.customer_code',
    'field.sales_order',
    'field.waybill_number',
    'field.rsh_number',
    'field.custodian',
    'field.custody_status',
    'field.product',
    'field.quantity',
    'field.reason',
    'field.actions',
    'panel.custody_returns',
    'panel.shipping_companies',
    'panel.vehicles',
    'panel.no_custody_results',
    'action.search',
    'action.initiate_custody_return',
  ]);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [companies, setCompanies] = useState<ShippingCompany[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [results, setResults] = useState<CustodyShipmentSearchResult[] | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [customerCode, setCustomerCode] = useState('');
  const [waybillNumber, setWaybillNumber] = useState('');
  const [rshNumber, setRshNumber] = useState('');
  const [shippingCompanyId, setShippingCompanyId] = useState('');
  const [vehicleId, setVehicleId] = useState('');

  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [returnReason, setReturnReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [customersData, companiesData, vehiclesData, productsData] = await Promise.all([
          api.get<Customer[]>('/customers'),
          api.get<ShippingCompany[]>('/shipments/shipping-companies'),
          api.get<Vehicle[]>('/shipments/vehicles'),
          api.get<Product[]>('/products'),
        ]);
        setCustomers(customersData);
        setCompanies(companiesData);
        setVehicles(vehiclesData);
        setProducts(productsData);
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setError(err instanceof ApiError ? err.message : 'Failed to load custody returns data.');
      }
    })();
  }, []);

  async function search() {
    setBusy('search');
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (customerId) params.set('customerId', customerId);
      if (customerCode) params.set('customerCode', customerCode);
      if (waybillNumber) params.set('waybillNumber', waybillNumber);
      if (rshNumber) params.set('rshNumber', rshNumber);
      if (shippingCompanyId) params.set('shippingCompanyId', shippingCompanyId);
      if (vehicleId) params.set('vehicleId', vehicleId);
      const data = await api.get<CustodyShipmentSearchResult[]>(`/shipments/custody-search?${params.toString()}`);
      setResults(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to search custody shipments.');
    } finally {
      setBusy(null);
    }
  }

  async function initiateReturn(result: CustodyShipmentSearchResult, productId: string, maxQuantity: number) {
    const key = `${result.shipmentId}:${productId}`;
    const quantity = returnQty[key] ?? maxQuantity;
    const reason = returnReason[key] ?? '';
    if (!reason.trim()) {
      setError('A reason is required to initiate a custody return.');
      return;
    }
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await api.post('/returns/custody', { shipmentId: result.shipmentId, productId, quantity, reason });
      setNotice(`Custody return initiated for ${products.find((p) => p.id === productId)?.sku ?? productId} (${quantity}).`);
      await search();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to initiate custody return.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('panel.custody_returns')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div style={{ color: 'var(--success, #2e7d32)', marginBottom: 12 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.customer')}</label>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.customer_code')}</label>
            <input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="CUST-0001" />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.waybill_number')}</label>
            <input value={waybillNumber} onChange={(e) => setWaybillNumber(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.rsh_number')}</label>
            <input value={rshNumber} onChange={(e) => setRshNumber(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('panel.shipping_companies')}</label>
            <select value={shippingCompanyId} onChange={(e) => setShippingCompanyId(e.target.value)}>
              <option value="">—</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('panel.vehicles')}</label>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">—</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plateNumber}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" disabled={busy === 'search'} onClick={search}>
            {t('action.search')}
          </button>
        </div>
      </div>

      {results === null ? null : results.length === 0 ? (
        <div className="empty-state">{t('panel.no_custody_results')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.customer')}</th>
              <th>{t('field.sales_order')}</th>
              <th>{t('field.waybill_number')}</th>
              <th>{t('field.rsh_number')}</th>
              <th>{t('field.custodian')}</th>
              <th>{t('field.custody_status')}</th>
              <th>{t('field.product')}</th>
              <th>{t('field.quantity')}</th>
              <th>{t('field.reason')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {results.flatMap((r) =>
              r.items.length === 0
                ? [
                    <tr key={r.shipmentId}>
                      <td>
                        {r.customerName ?? r.customerId} ({r.customerCode ?? '—'})
                      </td>
                      <td>{r.salesOrderNumber ?? r.salesOrderId}</td>
                      <td>{r.waybillNumber}</td>
                      <td>{r.rshNumber ?? '—'}</td>
                      <td>
                        {r.custodianType === 'vehicle' ? t('panel.vehicles') : t('panel.shipping_companies')}: {r.custodianName}
                      </td>
                      <td>
                        <StatusBadge code={`shipment_lifecycle.state.${r.currentCustodyStatus}`} />
                      </td>
                      <td colSpan={4} className="empty-state" style={{ padding: 8 }}>
                        {t('panel.no_custody_results')}
                      </td>
                    </tr>,
                  ]
                : r.items.map((item) => {
                    const key = `${r.shipmentId}:${item.productId}`;
                    return (
                      <tr key={key}>
                        <td>
                          {r.customerName ?? r.customerId} ({r.customerCode ?? '—'})
                        </td>
                        <td>{r.salesOrderNumber ?? r.salesOrderId}</td>
                        <td>{r.waybillNumber}</td>
                        <td>{r.rshNumber ?? '—'}</td>
                        <td>
                          {r.custodianType === 'vehicle' ? t('panel.vehicles') : t('panel.shipping_companies')}: {r.custodianName}
                        </td>
                        <td>
                          <StatusBadge code={`shipment_lifecycle.state.${r.currentCustodyStatus}`} />
                        </td>
                        <td>{products.find((p) => p.id === item.productId)?.sku ?? item.productId}</td>
                        <td style={{ width: 80 }}>
                          <input
                            type="number"
                            min={1}
                            max={item.quantity}
                            value={returnQty[key] ?? item.quantity}
                            onChange={(e) => setReturnQty((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                          />
                          <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>/ {item.quantity}</div>
                        </td>
                        <td style={{ minWidth: 140 }}>
                          <input
                            value={returnReason[key] ?? ''}
                            onChange={(e) => setReturnReason((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        </td>
                        <td>
                          <button
                            className="btn btn-secondary"
                            disabled={busy === key}
                            onClick={() => initiateReturn(r, item.productId, item.quantity)}
                          >
                            {t('action.initiate_custody_return')}
                          </button>
                        </td>
                      </tr>
                    );
                  }),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
