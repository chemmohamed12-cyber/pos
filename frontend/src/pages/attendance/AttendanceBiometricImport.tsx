import { useEffect, useRef, useState } from 'react';
import { ApiError, api, downloadBlob, uploadFile } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { fmtDateTime } from '../../lib/formatDateTime';

interface BiometricImportRow {
  acNo: string;
  name: string;
  date: string;
  onDuty: string;
  offDuty: string;
  clockIn: string;
  clockOut: string;
  late: string;
  early: string;
  absent: string;
  otTime: string;
}
interface RejectedRow {
  row: number;
  errors: string[];
}
interface ImportSummary {
  totalRows: number;
  succeeded: BiometricImportRow[];
  rejected: RejectedRow[];
  warnings: string[];
}
interface ImportBatch {
  id: string;
  fileName: string;
  totalRows: number;
  succeededCount: number;
  rejectedCount: number;
  importedAt: string;
}
interface UnmappedBiometricRow {
  id: string;
  deviceUserRef: string;
  sourceName: string | null;
  calendarDate: string;
}

/**
 * CTO directive (2026-09-20) — surfaces the confirmed real Biometric Daily
 * Attendance Summary import (backend commits `9d43a1a`/`49938c7`). Same
 * template -> upload -> preview (no writes) -> confirm shape as
 * `AttendanceImport`, plus the unmapped-AC-No. queue and import history
 * this format's own governance (§8/§9/§10 of the directive) requires.
 */
export function AttendanceBiometricImport() {
  const { t, preload } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedBiometricRow[] | null>(null);
  const [history, setHistory] = useState<ImportBatch[] | null>(null);

  preload([
    'nav.attendance_biometric_import',
    'field.ac_no',
    'field.source_name',
    'field.calendar_date',
    'field.on_duty',
    'field.off_duty',
    'field.check_in',
    'field.check_out',
    'field.late',
    'field.early',
    'field.absent_flag',
    'field.ot_time',
    'field.file_name',
    'field.total_rows',
    'field.succeeded_count',
    'field.rejected_count',
    'field.import_date',
    'action.download_biometric_template',
    'action.upload_biometric_file',
    'action.preview_import',
    'action.confirm_import',
    'panel.no_biometric_unmapped_yet',
    'panel.no_biometric_history_yet',
    'panel.biometric_facts_not_payroll_notice',
    'panel.biometric_schedule_vs_actual_notice',
  ]);

  async function loadUnmapped() {
    try {
      setUnmapped(await api.get<UnmappedBiometricRow[]>('/attendance/biometric-import/unmapped'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load unmapped biometric rows.');
    }
  }
  async function loadHistory() {
    try {
      setHistory(await api.get<ImportBatch[]>('/attendance/biometric-import/history'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load import history.');
    }
  }

  useEffect(() => {
    loadUnmapped();
    loadHistory();
  }, []);

  async function onDownloadTemplate() {
    setError(null);
    try {
      const blob = await downloadBlob('/attendance/biometric-import-template');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'biometric-daily-attendance-template.xlsx';
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
      setPreview(await uploadFile<ImportSummary>('/attendance/biometric-import/preview', selectedFile));
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
      setResult(await uploadFile<ImportBatch>('/attendance/biometric-import', selectedFile));
      setPreview(null);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await Promise.all([loadUnmapped(), loadHistory()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.attendance_biometric_import')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20, background: 'var(--panel-info-bg, #eef4ff)' }}>
        <p style={{ margin: 0 }}>{t('panel.biometric_schedule_vs_actual_notice')}</p>
        <p style={{ margin: '8px 0 0' }}>{t('panel.biometric_facts_not_payroll_notice')}</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <button className="btn btn-secondary" onClick={onDownloadTemplate} style={{ marginBottom: 16 }}>
          {t('action.download_biometric_template')}
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
            <table className="data-table" style={{ marginBottom: 16 }}>
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
          {preview.succeeded.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.ac_no')}</th>
                  <th>{t('field.source_name')}</th>
                  <th>{t('field.calendar_date')}</th>
                  <th>{t('field.on_duty')}</th>
                  <th>{t('field.off_duty')}</th>
                  <th>{t('field.check_in')}</th>
                  <th>{t('field.check_out')}</th>
                  <th>{t('field.late')}</th>
                  <th>{t('field.early')}</th>
                  <th>{t('field.absent_flag')}</th>
                  <th>{t('field.ot_time')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.succeeded.map((r, i) => (
                  <tr key={i}>
                    <td>{r.acNo}</td>
                    <td>{r.name || '—'}</td>
                    <td>{r.date}</td>
                    <td>{r.onDuty || '—'}</td>
                    <td>{r.offDuty || '—'}</td>
                    <td>{r.clockIn || '—'}</td>
                    <td>{r.clockOut || '—'}</td>
                    <td>{r.late || '—'}</td>
                    <td>{r.early || '—'}</td>
                    <td>{r.absent || '—'}</td>
                    <td>{r.otTime || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {result && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p>
            {result.fileName} — {t('field.total_rows')}: {result.totalRows} — {t('field.succeeded_count')}: {result.succeededCount} — {t('field.rejected_count')}: {result.rejectedCount}
          </p>
        </div>
      )}

      <h3>{t('field.ac_no')}</h3>
      {unmapped === null ? (
        <div className="empty-state">Loading…</div>
      ) : unmapped.length === 0 ? (
        <div className="empty-state">{t('panel.no_biometric_unmapped_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.ac_no')}</th>
              <th>{t('field.source_name')}</th>
              <th>{t('field.calendar_date')}</th>
            </tr>
          </thead>
          <tbody>
            {unmapped.map((r) => (
              <tr key={r.id}>
                <td>{r.deviceUserRef}</td>
                <td>{r.sourceName ?? '—'}</td>
                <td>{r.calendarDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{t('field.import_date')}</h3>
      {history === null ? (
        <div className="empty-state">Loading…</div>
      ) : history.length === 0 ? (
        <div className="empty-state">{t('panel.no_biometric_history_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.file_name')}</th>
              <th>{t('field.import_date')}</th>
              <th>{t('field.total_rows')}</th>
              <th>{t('field.succeeded_count')}</th>
              <th>{t('field.rejected_count')}</th>
            </tr>
          </thead>
          <tbody>
            {history.map((b) => (
              <tr key={b.id}>
                <td>{b.fileName}</td>
                <td>{fmtDateTime(b.importedAt)}</td>
                <td>{b.totalRows}</td>
                <td>{b.succeededCount}</td>
                <td>{b.rejectedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
