import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';

interface Transaction {
  id: string;
  transactionNumber: string;
  type: string;
  warehouseId: string;
  state: string;
  createdAt: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface TransactionsPage {
  rows: Transaction[];
  total: number;
}

const CREATE_TYPES = ['receipt', 'issue', 'transfer', 'adjustment'] as const;
const PAGE_SIZE = 50;

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive §7) — "not ten
 * similar screens; one Inventory Movement Center" that opens the
 * relevant operation directly. Read-only list here; every write goes
 * through <WarehouseTransactionForm>/<WarehouseTransactionDetail>.
 */
export function MovementCenter() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [assembleOpen, setAssembleOpen] = useState(false);
  const [assembleWarehouseId, setAssembleWarehouseId] = useState('');
  const [assembleProductId, setAssembleProductId] = useState('');
  const [assembleQuantity, setAssembleQuantity] = useState(1);
  const [assembling, setAssembling] = useState(false);
  const [assemblyReference, setAssemblyReference] = useState<string | null>(null);
  const [assembleError, setAssembleError] = useState<string | null>(null);

  preload([
    'nav.movement_center',
    ...CREATE_TYPES.map((ty) => `action.create_${ty}`),
    'action.start_count',
    'action.assemble',
    'field.finished_product',
    'field.quantity',
    'field.assembly_reference',
    'panel.assembly_success',
    'field.transaction_number',
    'field.warehouse',
    'field.status',
    'field.type',
    'field.all',
    'panel.no_transactions_yet',
    'action.previous_page',
    'action.next_page',
    'field.page_of_total',
    ...CREATE_TYPES.map((ty) => `warehouse_txn_type.${ty}`),
  ]);

  async function load() {
    setLoadError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (typeFilter) params.set('type', typeFilter);
      const [txnsPage, wh, prod] = await Promise.all([
        api.get<TransactionsPage>(`/warehouse-transactions?${params.toString()}`),
        api.get<Warehouse[]>('/inventory/warehouses'),
        api.get<Product[]>('/products/all'),
      ]);
      setTransactions(txnsPage.rows);
      setTotal(txnsPage.total);
      setWarehouses(wh);
      setProducts(prod);
      if (wh[0] && !assembleWarehouseId) setAssembleWarehouseId(wh[0].id);
    } catch (err) {
      // Foundation fix: this had no error handling — a failed load left
      // `transactions` at its initial `[]`, rendering as a false "no
      // transactions yet" empty state instead of a real failure.
      setLoadError(err);
    }
  }

  useEffect(() => {
    setPage(1);
  }, [typeFilter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, page]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  async function assemble() {
    if (!assembleWarehouseId || !assembleProductId) return;
    setAssembling(true);
    setAssembleError(null);
    setAssemblyReference(null);
    try {
      const result = await api.post<{ assemblyReference: string }>('/inventory/assemble', {
        warehouseId: assembleWarehouseId,
        finishedProductId: assembleProductId,
        quantity: assembleQuantity,
      });
      setAssemblyReference(result.assemblyReference);
    } catch (err) {
      setAssembleError(err instanceof ApiError ? err.message : 'Failed to assemble product.');
    } finally {
      setAssembling(false);
    }
  }

  const warehouseCode = (id: string) => warehouses.find((w) => w.id === id)?.code ?? id;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.movement_center')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="action-row" style={{ marginTop: 0 }}>
          {CREATE_TYPES.map((ty) => (
            <button key={ty} className="btn btn-primary" onClick={() => navigate(`/movement-center/new/${ty}`)}>
              {t(`action.create_${ty}`)}
            </button>
          ))}
          <button className="btn btn-secondary" onClick={() => navigate('/stock-count')}>
            {t('action.start_count')}
          </button>
          {hasRole('warehouse_worker', 'admin') && (
            <button className="btn btn-secondary" onClick={() => setAssembleOpen((v) => !v)}>
              {t('action.assemble')}
            </button>
          )}
        </div>
      </div>

      {assembleOpen && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('action.assemble')}</h3>
          {assembleError && <div className="error-text">{assembleError}</div>}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t('field.warehouse')}</label>
              <select value={assembleWarehouseId} onChange={(e) => setAssembleWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t('field.finished_product')}</label>
              <select value={assembleProductId} onChange={(e) => setAssembleProductId(e.target.value)}>
                <option value="" disabled>
                  —
                </option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, width: 100 }}>
              <label>{t('field.quantity')}</label>
              <input type="number" min={1} value={assembleQuantity} onChange={(e) => setAssembleQuantity(Number(e.target.value))} />
            </div>
            <button className="btn btn-primary" disabled={assembling || !assembleProductId} onClick={assemble}>
              {t('action.assemble')}
            </button>
          </div>
          {assemblyReference && (
            <div className="status-badge positive" style={{ marginTop: 12 }}>
              {t('panel.assembly_success')}: {assemblyReference}
            </div>
          )}
        </div>
      )}

      <div className="form-field" style={{ maxWidth: 220 }}>
        <label>{t('field.type')}</label>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{t('field.all')}</option>
          {[...CREATE_TYPES, 'count'].map((ty) => (
            <option key={ty} value={ty}>
              {t(`warehouse_txn_type.${ty}`)}
            </option>
          ))}
        </select>
      </div>

      {loadError ? (
        <ErrorState error={loadError} onRetry={load} />
      ) : transactions === null ? (
        <div className="empty-state">Loading…</div>
      ) : transactions.length === 0 ? (
        <div className="empty-state">{t('panel.no_transactions_yet')}</div>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.transaction_number')}</th>
                <th>{t('field.type')}</th>
                <th>{t('field.warehouse')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.created_at')}</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} onClick={() => navigate(`/movement-center/${tx.id}`)}>
                  <td>{tx.transactionNumber}</td>
                  <td>{t(`warehouse_txn_type.${tx.type}`)}</td>
                  <td>{warehouseCode(tx.warehouseId)}</td>
                  <td>
                    <StatusBadge code={`warehouse_txn_state.${tx.state}`} />
                  </td>
                  <td>{new Date(tx.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="action-row" style={{ marginTop: 14, alignItems: 'center' }}>
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('action.previous_page')}
            </button>
            <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>
              {t('field.page_of_total').replace('{page}', String(page)).replace('{total}', String(totalPages))}
            </span>
            <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              {t('action.next_page')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
