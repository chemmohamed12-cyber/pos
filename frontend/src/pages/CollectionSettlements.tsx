import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface PendingCollection {
  id: string;
  shipmentId: string;
  amount: string;
  method: string;
  remittanceStatus: string;
}
interface Shipment {
  id: string;
  waybillNumber: string;
  shippingCompanyId: string | null;
  vehicleId: string | null;
}
interface ShippingCompany {
  id: string;
  code: string;
  name: string;
  treasuryAccountId: string | null;
}
interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
  settlementAccountId: string | null;
}
interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
}

/**
 * CTO directive (Phase 5 — Custody/Visibility, resumed) — "a distinct
 * Collection Settlements nav item". This workflow (finance reviewing every
 * Collection still awaiting remittance, then closing it out to a Treasury
 * account) already existed embedded inside `Shipments.tsx`; this page is
 * its own destination now, same two endpoints, same behavior — not a new
 * engine.
 */
export function CollectionSettlements() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'nav.collection_settlements',
    'panel.pending_remittances',
    'panel.no_pending_remittances',
    'field.waybill',
    'field.collected_amount',
    'field.treasury_account',
    'field.actions',
    'action.remit',
    'action.print',
  ]);

  const canView = can('logistics.collection.view');
  const [pending, setPending] = useState<PendingCollection[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [companies, setCompanies] = useState<ShippingCompany[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [treasuryAccounts, setTreasuryAccounts] = useState<TreasuryAccount[]>([]);
  const [accountSelections, setAccountSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    if (!canView) return;
    try {
      const [pendingData, shipmentData, companiesData, vehiclesData, accountsData] = await Promise.all([
        api.get<PendingCollection[]>('/delivery/collections/pending-remittance'),
        api.get<Shipment[]>('/shipments'),
        api.get<ShippingCompany[]>('/shipments/shipping-companies'),
        api.get<Vehicle[]>('/shipments/vehicles'),
        api.get<TreasuryAccount[]>('/treasury/accounts'),
      ]);
      setPending(pendingData);
      setShipments(shipmentData);
      setCompanies(companiesData);
      setVehicles(vehiclesData);
      setTreasuryAccounts(accountsData);
    } catch (err) {
      // Foundation fix: mount-time load had no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load collection settlements.');
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  async function remit(collectionId: string) {
    setBusy(collectionId);
    setError(null);
    try {
      const treasuryAccountId = accountSelections[collectionId];
      await api.post(`/delivery/collections/${collectionId}/remit`, treasuryAccountId ? { treasuryAccountId } : {});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remit collection.');
    } finally {
      setBusy(null);
    }
  }

  if (!canView) return <div className="empty-state">—</div>;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.collection_settlements')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('panel.pending_remittances')}</h3>
        {pending.length === 0 ? (
          <div className="empty-state">{t('panel.no_pending_remittances')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.waybill')}</th>
                <th>{t('field.collected_amount')}</th>
                <th>{t('field.treasury_account')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((c) => {
                const shipment = shipments.find((s) => s.id === c.shipmentId);
                const company = shipment?.shippingCompanyId ? companies.find((sc) => sc.id === shipment.shippingCompanyId) : null;
                const vehicle = shipment?.vehicleId ? vehicles.find((v) => v.id === shipment.vehicleId) : null;
                const defaultAccountId = company?.treasuryAccountId ?? vehicle?.settlementAccountId ?? '';
                return (
                  <tr key={c.id}>
                    <td>{shipment?.waybillNumber ?? c.shipmentId}</td>
                    <td>{c.amount}</td>
                    <td>
                      <select
                        value={accountSelections[c.id] ?? defaultAccountId}
                        onChange={(e) => setAccountSelections((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      >
                        <option value="">—</option>
                        {treasuryAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button className="btn btn-primary" disabled={busy === c.id} onClick={() => remit(c.id)}>
                        {t('action.remit')}
                      </button>{' '}
                      <button className="btn btn-secondary" onClick={() => window.open(`/print/collection/${c.shipmentId}`, '_blank')}>
                        {t('action.print')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
