import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { currentLang } from '../lib/displayNames';

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}
interface ShippingCompany {
  id: string;
  code: string;
  name: string;
  contactPhone: string | null;
  address: string | null;
  responsiblePerson: string | null;
  status: string;
}
interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
  driverUserId: string | null;
  shippingCompanyId: string | null;
  branch: string | null;
  /** Validated owning branch (org engine); `branch` is the legacy free text. */
  orgUnitId?: string | null;
  status: 'active' | 'retired';
}
interface BranchUnit {
  id: string;
  name: string;
}
interface CustodianOverview {
  custodyBalance: string | null;
  activeShipmentsCount: number;
}

/**
 * Shipping section — "طرق الشحن" (Shipping Methods), split out of
 * `Shipments.tsx` into its own sub-item under Shipping (alongside
 * الشحنات/مرتجعات الشحن/تسويات التحصيل), per CTO request. Same data, same
 * endpoints, same admin-only write gate as before — only the page it lives
 * on changed. `Shipments.tsx` still reads the plain company/vehicle LISTS
 * for its own create-shipment dropdowns and name/plate lookups; this page
 * owns the CRUD (add company/vehicle, change driver, retire/reactivate)
 * and the custody overview (money + goods under custody) per custodian.
 */
export function ShippingMethods() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'nav.shipping_methods',
    'panel.shipping_companies',
    'field.shipping_company_code',
    'field.shipping_company',
    'field.contact_phone',
    'field.address',
    'field.responsible_person',
    'field.custody_balance',
    'field.active_shipments',
    'field.status',
    'field.actions',
    'action.view_details',
    'action.print',
    'action.add_shipping_company',
    'panel.vehicles',
    'field.vehicle_code',
    'field.plate_number',
    'field.branch',
    'field.driver',
    'action.change_driver',
    'action.retire',
    'action.reactivate',
    'action.add_vehicle',
    'field.no_shipping_company',
  ]);

  const [shippingCompanies, setShippingCompanies] = useState<ShippingCompany[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<AdminUser[]>([]);
  const [custodyOverviews, setCustodyOverviews] = useState<Record<string, CustodianOverview>>({});
  const [newCompanyCode, setNewCompanyCode] = useState('');
  const [newCompanyName, setNewCompanyName] = useState('');
  const [newCompanyPhone, setNewCompanyPhone] = useState('');
  const [newCompanyAddress, setNewCompanyAddress] = useState('');
  const [newCompanyResponsible, setNewCompanyResponsible] = useState('');
  const [newVehicleCode, setNewVehicleCode] = useState('');
  const [newVehiclePlate, setNewVehiclePlate] = useState('');
  const [newVehicleCompanyId, setNewVehicleCompanyId] = useState('');
  const [newVehicleBranch, setNewVehicleBranch] = useState('');
  const [branches, setBranches] = useState<BranchUnit[]>([]);
  const ar = currentLang() === 'ar';
  const [vehicleDriverSelections, setVehicleDriverSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canView = can('wf.logistics.nav.shipping_methods', 'editable');

  async function loadAll() {
    if (!canView) return;
    try {
      const [companies, vehicleData, users, units] = await Promise.all([
        api.get<ShippingCompany[]>('/shipments/shipping-companies'),
        api.get<Vehicle[]>('/shipments/vehicles'),
        api.get<AdminUser[]>('/admin/users'),
        api.get<Array<BranchUnit & { type: string; status?: string }>>('/organization/units').catch(() => []),
      ]);
      const activeBranches = units.filter((u) => u.type === 'branch' && (u.status ?? 'active') === 'active');
      setBranches(activeBranches);
      setNewVehicleBranch((prev) => prev || (activeBranches.length === 1 ? activeBranches[0].id : ''));
      setShippingCompanies(companies);
      setVehicles(vehicleData);
      setDrivers(users);

      // CTO directive §8/§11 — "البضاعة تحت العهدة + الأموال تحت العهدته" per
      // custodian. One overview call per custodian (small-N precedent already
      // established elsewhere in this codebase, e.g. Reports).
      const overviewEntries = await Promise.all([
        ...companies.map(async (c) => [c.id, await api.get<CustodianOverview>(`/shipments/shipping-companies/${c.id}/overview`)] as const),
        ...vehicleData.map(async (v) => [v.id, await api.get<CustodianOverview>(`/shipments/vehicles/${v.id}/overview`)] as const),
      ]);
      setCustodyOverviews(Object.fromEntries(overviewEntries));
    } catch (err) {
      // Foundation fix: mount-time load had no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load shipping methods.');
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  async function addShippingCompany() {
    if (!newCompanyCode || !newCompanyName) return;
    setBusy('add-company');
    setError(null);
    try {
      await api.post('/shipments/shipping-companies', {
        code: newCompanyCode,
        name: newCompanyName,
        ...(newCompanyPhone ? { contactPhone: newCompanyPhone } : {}),
        ...(newCompanyAddress ? { address: newCompanyAddress } : {}),
        ...(newCompanyResponsible ? { responsiblePerson: newCompanyResponsible } : {}),
      });
      setNewCompanyCode('');
      setNewCompanyName('');
      setNewCompanyPhone('');
      setNewCompanyAddress('');
      setNewCompanyResponsible('');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add shipping company.');
    } finally {
      setBusy(null);
    }
  }

  async function assignVehicleBranch(vehicleId: string, orgUnitId: string) {
    setBusy(vehicleId + 'branch');
    setError(null);
    try {
      await api.post(`/shipments/vehicles/${vehicleId}`, { orgUnitId });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign the branch.');
    } finally {
      setBusy(null);
    }
  }

  async function addVehicle() {
    if (!newVehicleCode || !newVehiclePlate) return;
    setBusy('add-vehicle');
    setError(null);
    try {
      await api.post('/shipments/vehicles', {
        code: newVehicleCode,
        plateNumber: newVehiclePlate,
        ...(newVehicleCompanyId ? { shippingCompanyId: newVehicleCompanyId } : {}),
        // the branch is chosen from the organization tree and validated again on the server
        ...(newVehicleBranch ? (branches.length > 0 ? { orgUnitId: newVehicleBranch } : { branch: newVehicleBranch }) : {}),
      });
      setNewVehicleCode('');
      setNewVehiclePlate('');
      setNewVehicleCompanyId('');
      setNewVehicleBranch(branches.length === 1 ? branches[0].id : '');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add vehicle.');
    } finally {
      setBusy(null);
    }
  }

  async function changeVehicleDriver(vehicleId: string) {
    const driverUserId = vehicleDriverSelections[vehicleId];
    if (!driverUserId) return;
    setBusy(vehicleId + 'driver');
    setError(null);
    try {
      await api.post(`/shipments/vehicles/${vehicleId}/driver`, { driverUserId });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change vehicle driver.');
    } finally {
      setBusy(null);
    }
  }

  /** CTO directive §2 — a vehicle with operational history is retired, never deleted. */
  async function toggleVehicleStatus(vehicle: Vehicle) {
    setBusy(vehicle.id + 'status');
    setError(null);
    try {
      await api.post(`/shipments/vehicles/${vehicle.id}/status`, { status: vehicle.status === 'active' ? 'retired' : 'active' });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update vehicle status.');
    } finally {
      setBusy(null);
    }
  }

  if (!canView) return <div className="empty-state">—</div>;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.shipping_methods')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('panel.shipping_companies')}</h3>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>{t('field.shipping_company_code')}</th>
              <th>{t('field.shipping_company')}</th>
              <th>{t('field.contact_phone')}</th>
              <th>{t('field.address')}</th>
              <th>{t('field.responsible_person')}</th>
              <th>{t('field.custody_balance')}</th>
              <th>{t('field.active_shipments')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {shippingCompanies.map((c) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{c.contactPhone ?? '—'}</td>
                <td>{c.address ?? '—'}</td>
                <td>{c.responsiblePerson ?? '—'}</td>
                <td>{custodyOverviews[c.id]?.custodyBalance ?? '—'}</td>
                <td>{custodyOverviews[c.id]?.activeShipmentsCount ?? '—'}</td>
                <td>
                  <StatusBadge code={`warehouse_status.${c.status}`} />
                </td>
                <td>
                  <Link className="btn btn-secondary" style={{ marginInlineEnd: 6 }} to={`/custodian/company/${c.id}`}>
                    {t('action.view_details')}
                  </Link>
                  <button className="btn btn-secondary" onClick={() => window.open(`/print/custody/company/${c.id}`, '_blank')}>
                    {t('action.print')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ width: 140, marginBottom: 0 }}>
            <label>{t('field.shipping_company_code')}</label>
            <input value={newCompanyCode} onChange={(e) => setNewCompanyCode(e.target.value)} />
          </div>
          <div className="form-field" style={{ minWidth: 200, marginBottom: 0 }}>
            <label>{t('field.shipping_company')}</label>
            <input value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)} />
          </div>
          <div className="form-field" style={{ width: 160, marginBottom: 0 }}>
            <label>{t('field.contact_phone')}</label>
            <input value={newCompanyPhone} onChange={(e) => setNewCompanyPhone(e.target.value)} />
          </div>
          <div className="form-field" style={{ minWidth: 200, marginBottom: 0 }}>
            <label>{t('field.address')}</label>
            <input value={newCompanyAddress} onChange={(e) => setNewCompanyAddress(e.target.value)} />
          </div>
          <div className="form-field" style={{ width: 160, marginBottom: 0 }}>
            <label>{t('field.responsible_person')}</label>
            <input value={newCompanyResponsible} onChange={(e) => setNewCompanyResponsible(e.target.value)} />
          </div>
          <button
            className="btn btn-secondary"
            disabled={!newCompanyCode || !newCompanyName || busy === 'add-company'}
            onClick={addShippingCompany}
          >
            {t('action.add_shipping_company')}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('panel.vehicles')}</h3>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>{t('field.vehicle_code')}</th>
              <th>{t('field.plate_number')}</th>
              <th>{t('field.shipping_company')}</th>
              <th>{t('field.branch')}</th>
              <th>{t('field.driver')}</th>
              <th>{t('field.custody_balance')}</th>
              <th>{t('field.active_shipments')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td>{v.code}</td>
                <td>{v.plateNumber}</td>
                <td>{v.shippingCompanyId ? (shippingCompanies.find((c) => c.id === v.shippingCompanyId)?.name ?? '—') : '—'}</td>
                <td>
                  {v.orgUnitId ? (
                    (branches.find((b) => b.id === v.orgUnitId)?.name ?? v.branch ?? '—')
                  ) : (
                    <>
                      {v.branch ?? '—'}
                      {branches.length > 0 && (
                        <div>
                          <select value="" onChange={(e) => e.target.value && assignVehicleBranch(v.id, e.target.value)} data-testid="vehicle-assign-branch">
                            <option value="">{ar ? 'غير مرتبط — حدد الفرع' : 'Unassigned — choose branch'}</option>
                            {branches.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select
                      value={vehicleDriverSelections[v.id] ?? v.driverUserId ?? ''}
                      onChange={(e) => setVehicleDriverSelections((prev) => ({ ...prev, [v.id]: e.target.value }))}
                    >
                      <option value="">—</option>
                      {drivers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.fullName}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-secondary" disabled={busy === v.id + 'driver'} onClick={() => changeVehicleDriver(v.id)}>
                      {t('action.change_driver')}
                    </button>
                  </div>
                </td>
                <td>{custodyOverviews[v.id]?.custodyBalance ?? '—'}</td>
                <td>{custodyOverviews[v.id]?.activeShipmentsCount ?? '—'}</td>
                <td>
                  <StatusBadge code={`vehicle_status.${v.status}`} />
                </td>
                <td>
                  <button className="btn btn-secondary" style={{ marginInlineEnd: 6 }} disabled={busy === v.id + 'status'} onClick={() => toggleVehicleStatus(v)}>
                    {v.status === 'active' ? t('action.retire') : t('action.reactivate')}
                  </button>
                  <Link className="btn btn-secondary" style={{ marginInlineEnd: 6 }} to={`/custodian/vehicle/${v.id}`}>
                    {t('action.view_details')}
                  </Link>
                  <button className="btn btn-secondary" onClick={() => window.open(`/print/custody/vehicle/${v.id}`, '_blank')}>
                    {t('action.print')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ width: 140, marginBottom: 0 }}>
            <label>{t('field.vehicle_code')}</label>
            <input value={newVehicleCode} onChange={(e) => setNewVehicleCode(e.target.value)} />
          </div>
          <div className="form-field" style={{ width: 140, marginBottom: 0 }}>
            <label>{t('field.plate_number')}</label>
            <input value={newVehiclePlate} onChange={(e) => setNewVehiclePlate(e.target.value)} />
          </div>
          <div className="form-field" style={{ minWidth: 200, marginBottom: 0 }}>
            <label>{t('field.shipping_company')}</label>
            <select value={newVehicleCompanyId} onChange={(e) => setNewVehicleCompanyId(e.target.value)}>
              <option value="">{t('field.no_shipping_company')}</option>
              {shippingCompanies
                .filter((c) => c.status === 'active')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="form-field" style={{ width: 160, marginBottom: 0 }}>
            <label>{t('field.branch')}</label>
            {branches.length > 0 ? (
              <select value={newVehicleBranch} onChange={(e) => setNewVehicleBranch(e.target.value)} data-testid="vehicle-branch-select">
                <option value="">{ar ? 'اختر الفرع' : 'Select branch'}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : (
              <input value={newVehicleBranch} onChange={(e) => setNewVehicleBranch(e.target.value)} />
            )}
          </div>
          <button
            className="btn btn-secondary"
            disabled={!newVehicleCode || !newVehiclePlate || (branches.length > 0 && !newVehicleBranch) || busy === 'add-vehicle'}
            onClick={addVehicle}
          >
            {t('action.add_vehicle')}
          </button>
        </div>
      </div>
    </div>
  );
}
