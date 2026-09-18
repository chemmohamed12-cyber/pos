import { useRef, useState } from 'react';
import { getAccessToken } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

interface RejectedRow {
  row: number;
  errors: string[];
}
interface ImportSummary {
  totalRows: number;
  succeededCount: number;
  rejectedCount?: number;
  rejected: RejectedRow[];
  headerErrors: string[];
}

/**
 * Reusable Excel import/export widget (CTO finalization directive §3/§4)
 * — every master-data screen (Products, Customers, Warehouses, Inventory
 * opening stock) uses this SAME component; only the three endpoint URLs
 * differ. Downloads go through `fetch` + a Blob URL (not a plain
 * `<a href>`) because these endpoints require the JWT auth header —
 * a bare link can't attach one.
 */
export function ExcelImportExport({
  templateUrl,
  exportUrl,
  importUrl,
  onImported,
}: {
  templateUrl: string;
  exportUrl?: string;
  importUrl: string;
  onImported?: () => void;
}) {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function downloadFile(url: string, busyKey: string, filename: string) {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
      if (!res.ok) throw new Error(`Download failed (status ${res.status}).`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setBusy(null);
    }
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy('import');
    setError(null);
    setSummary(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(importUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAccessToken()}` },
        body: formData,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? 'Import failed.');
      setSummary(json.data as ImportSummary);
      if ((json.data as ImportSummary).succeededCount > 0) onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn btn-secondary"
          disabled={busy === 'template'}
          onClick={() => downloadFile(templateUrl, 'template', 'import-template.xlsx')}
        >
          {t('action.download_template')}
        </button>
        {exportUrl && (
          <button className="btn btn-secondary" disabled={busy === 'export'} onClick={() => downloadFile(exportUrl, 'export', 'export.xlsx')}>
            {t('action.export_excel')}
          </button>
        )}
        <button className="btn btn-primary" disabled={busy === 'import'} onClick={() => fileInputRef.current?.click()}>
          {t('action.import_excel')}
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChosen} />
      </div>

      {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}

      {summary && (
        <div style={{ marginTop: 14 }}>
          {summary.headerErrors.length > 0 ? (
            <div className="error-text">{summary.headerErrors.join(' ')}</div>
          ) : (
            <>
              <div className="detail-grid" style={{ marginBottom: summary.rejected.length > 0 ? 10 : 0 }}>
                <div className="detail-field">
                  <div className="label">{t('field.total_rows')}</div>
                  <div className="value">{summary.totalRows}</div>
                </div>
                <div className="detail-field">
                  <div className="label">{t('field.succeeded_rows')}</div>
                  <div className="value" style={{ color: '#1c7a3e' }}>{summary.succeededCount}</div>
                </div>
                <div className="detail-field">
                  <div className="label">{t('field.rejected_rows')}</div>
                  <div className="value" style={{ color: summary.rejected.length > 0 ? '#a3262d' : undefined }}>
                    {summary.rejected.length}
                  </div>
                </div>
              </div>
              {summary.rejected.length > 0 && (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('field.row')}</th>
                      <th>{t('field.errors')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rejected.map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>{r.errors.join(' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
