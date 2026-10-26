import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { loadingLabel } from '../../lib/displayNames';
import { useTr } from '../treasury/treasuryUi';
import './vehicle-workspace.css';

interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
  driverUserId: string | null;
  branch: string | null;
  status: 'active' | 'retired';
}

/**
 * Entry point of the Vehicle Driver Workspace. `/my-vehicle` (mine=true) opens the workspace of the vehicle the signed-in user is the assigned driver of — straight away when there is
 * exactly one; otherwise (several, or an administrator) a list to choose from. `/vehicle-workspace` always lists. Read-only: the list is the existing `GET /shipments/vehicles`.
 */
export function VehiclePicker({ mine = false }: { mine?: boolean }) {
  const tr = useTr();
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    setError(null);
    api.get<Vehicle[]>('/shipments/vehicles').then(setVehicles).catch(setError);
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="vw-root">
        <div className="vw-pad">
          <ErrorState error={error} onRetry={load} />
        </div>
      </div>
    );
  }
  if (!vehicles) {
    return (
      <div className="vw-root">
        <div className="vw-pad vw-center" role="status">
          {loadingLabel()}
        </div>
      </div>
    );
  }
  const mineList = vehicles.filter((v) => v.driverUserId === user?.id && v.status === 'active');
  if (mine && mineList.length === 1) return <Navigate to={`/vehicle-workspace/${mineList[0].id}`} replace />;
  const list = mine && mineList.length > 0 ? mineList : vehicles.filter((v) => v.status === 'active');
  return (
    <div className="vw-root">
      <div className="vw-pad">
        <Link to="/" className="vw-link">
          ← {tr('الرئيسية', 'Home')}
        </Link>
        <h1 className="vw-h1">{tr('مساحة عمل السيارات', 'Vehicle workspace')}</h1>
        {mine && mineList.length === 0 && <div className="vw-banner warn">{tr('لا توجد سيارة نشطة معيّنة لك كسائق. يمكنك اختيار سيارة من القائمة إن كانت صلاحياتك تسمح.', 'No active vehicle is assigned to you as the driver. You can pick a vehicle below if your permissions allow it.')}</div>}
        {list.length === 0 ? (
          <div className="vw-empty">{tr('لا توجد سيارات نشطة.', 'There are no active vehicles.')}</div>
        ) : (
          <ul className="vw-list">
            {list.map((v) => (
              <li key={v.id}>
                <Link to={`/vehicle-workspace/${v.id}`} className="vw-card">
                  <div className="vw-card-row">
                    <span className="vw-waybill">{v.code}</span>
                    <span className="vw-plate" dir="ltr">
                      {v.plateNumber}
                    </span>
                  </div>
                  <div className="vw-card-meta">
                    <span>
                      {tr('الفرع', 'Branch')}: {v.branch ?? '—'}
                    </span>
                    {v.driverUserId === user?.id && <span className="vw-chip ok">{tr('سيارتي', 'My vehicle')}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
