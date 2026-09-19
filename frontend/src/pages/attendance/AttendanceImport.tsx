import { useRef, useState } from 'react';
import { ApiError, downloadBlob, uploadFile } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface ImportRow {
  deviceUserRef: string;
  punchTimestamp: string;
  punchType: string;
}
interface RejectedRow {
  row: number;
  errors: string[];
}
interface ImportSummary {
  totalRows: number;
  succeeded: ImportRow[];
  rejected: RejectedRow[];
  warnings: string[];
}
interface ImportBatch {
  id: string;
  fileName: string;
  totalRows: number;
  succeededCount: number;
  rejectedCount: number;
}

/** ADR-065 §6 — template -> upload -> preview (no writes) -> confirm import. A byte-identical re-upload is rejected server-side (fileHash idempotency). */
export function AttendanceImport() {
  const { t, preload } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.attendance_import',
    'field.file_name',
    'field.total_rows',
    'field.succeeded_count',
    'field.rejected_count',
    'field.device_ref',
    'field.punch_timestamp',
    'field.punch_type',
    'action.download_template',
    'action.upload_file',
    'action.preview_import',
    'action.confirm_import',
  ]);

  async function onDownloadTemplate() {
    setError(null);
    try {
      const blob = await downloadBlob('/attendance/import-template');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'attendance-import-template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to download template.');
    }
  }

  function onFileSelected() {
    const file = fileInputRef.current?.files?.[0] ?? null;
    setSelectedFile(file);
    setPreview(null);
    setResult(null);
  }

  async function onPreview() {
    if (!selectedFile) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await uploadFile<ImportSummary>('/attendance/import/preview', selectedFile));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to preview import.');
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmImport() {
    if (!selectedFile) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await uploadFile<ImportBatch>('/attendance/import', selectedFile));
      setPreview(null);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.attendance_import')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <button className="btn btn-secondary" onClick={onDownloadTemplate} style={{ marginBottom: 16 }}>
          {t('action.download_template')}
        </button>
        <div>
          <input ref={fileInputRef} type="file" accept=".xlsx" onChange={onFileSelected} />
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <button className="btn btn-secondary" disabled={!selectedFile || busy} onClick={onPreview}>
            {t('action.preview_import')}
          </button>
          <button className="btn btn-primary" disabled={!preview || busy} onClick={onConfirmImport}>
            {t('action.confirm_import')}
          </button>
        </div>
      </div>

      {preview && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p>
            {t('field.total_rows')}: {preview.totalRows} — {t('field.succeeded_count')}: {preview.succeeded.length} — {t('field.rejected_count')}: {preview.rejected.length}
          </p>
          {preview.rejected.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {preview.rejected.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>{r.errors.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {result && (
        <div className="card">
          <p>
            {result.fileName} — {t('field.total_rows')}: {result.totalRows} — {t('field.succeeded_count')}: {result.succeededCount} — {t('field.rejected_count')}: {result.rejectedCount}
          </p>
        </div>
      )}
    </div>
  );
}
