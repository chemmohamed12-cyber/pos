import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ProfileFieldsCard, type ProfileField } from '../components/profile/ProfileFieldsCard';
import { ProfileContactsPanel, type ProfileContact } from '../components/profile/ProfileContactsPanel';
import { ProfileAddressesPanel, type ProfileAddress } from '../components/profile/ProfileAddressesPanel';

/**
 * Customer profile tab (master-data gap matrix §5) — shown inside the existing Customer Account screen, so the customer record, its orders
 * and its ledger stay exactly where they were. Reads `GET /customers/:id/profile`; every write goes through `/customers/:id/update`,
 * `/contacts` and `/addresses` (permission `sales.customer.edit`). Financial settings stay on their own screen/permission.
 */
interface ProfileResponse {
  customer: Record<string, string | null>;
  addresses: Array<ProfileAddress & { isBilling: boolean; isShipping: boolean }>;
  contacts: ProfileContact[];
}

const FIELDS: ProfileField[] = [
  { key: 'name', labelCode: 'field.name' },
  {
    key: 'partyType',
    labelCode: 'field.party_type',
    kind: 'select',
    options: [
      { value: 'company', labelCode: 'value.party_type.company' },
      { value: 'individual', labelCode: 'value.party_type.individual' },
    ],
  },
  { key: 'legalName', labelCode: 'field.legal_name' },
  { key: 'taxRegistrationNumber', labelCode: 'field.tax_registration_number' },
  { key: 'vatRegistrationNumber', labelCode: 'field.vat_registration_number' },
  { key: 'commercialRegistrationNumber', labelCode: 'field.commercial_registration_number' },
  { key: 'phone', labelCode: 'field.phone' },
  { key: 'whatsappPhone', labelCode: 'field.whatsapp_phone' },
  { key: 'managerName', labelCode: 'field.manager_name' },
  { key: 'email', labelCode: 'field.email', kind: 'email' },
  { key: 'website', labelCode: 'field.website', kind: 'url' },
  {
    key: 'language',
    labelCode: 'field.language',
    kind: 'select',
    options: [
      { value: 'ar', labelCode: 'value.language.ar' },
      { value: 'en', labelCode: 'value.language.en' },
    ],
  },
  { key: 'address', labelCode: 'field.address', wide: true },
  { key: 'governorate', labelCode: 'field.governorate' },
  { key: 'internalNotes', labelCode: 'field.internal_notes', kind: 'textarea', wide: true },
];

export function CustomerProfileTab({ customerId, onChanged }: { customerId: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const canEdit = can('sales.customer.edit', 'editable');
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ProfileResponse>(`/customers/${customerId}/profile`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the customer profile.');
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const base = `/customers/${customerId}`;
  return (
    <div>
      <ProfileFieldsCard
        titleCode="panel.customer_profile"
        fields={FIELDS}
        values={data.customer}
        canEdit={canEdit}
        onSave={async (patch) => {
          await api.post(`${base}/update`, patch);
          await load();
          onChanged?.();
        }}
      />
      <ProfileContactsPanel
        contacts={data.contacts}
        canEdit={canEdit}
        onAdd={async (input) => {
          await api.post(`${base}/contacts`, input);
          await load();
        }}
        onSetPrimary={async (id) => {
          await api.post(`${base}/contacts/${id}/update`, { isPrimary: true });
          await load();
        }}
        onRemove={async (id) => {
          await api.post(`${base}/contacts/${id}/remove`, {});
          await load();
        }}
      />
      <ProfileAddressesPanel
        addresses={data.addresses}
        canEdit={canEdit}
        withFlags
        onAdd={async (input) => {
          await api.post(`${base}/addresses`, input);
          await load();
        }}
        onSetDefault={async (id) => {
          await api.post(`${base}/addresses/${id}/update`, { isDefault: true });
          await load();
        }}
        onRemove={async (id) => {
          await api.post(`${base}/addresses/${id}/remove`, {});
          await load();
        }}
      />
    </div>
  );
}
