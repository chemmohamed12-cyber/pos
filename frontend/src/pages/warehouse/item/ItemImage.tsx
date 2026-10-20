import { useEffect, useRef, useState } from 'react';
import { api, ApiError, downloadBlob, uploadFile } from '../../../lib/api';
import { useLanguage } from '../../../context/LanguageContext';

/**
 * The item's image in the Item Details header. Shown when the item has one (`GET /products/:id/image`), otherwise the code initials; a user who may edit the catalog can add, replace or
 * remove it (JPEG / PNG / GIF / WebP, up to 2 MB - validated again by the server). The picture is fetched with the session token and shown through an object URL.
 */
export function ItemImage({ productId, sku, canEdit }: { productId: string; sku: string; canEdit: boolean }) {
  const { lang } = useLanguage();
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const blob = await downloadBlob(`/products/${productId}/image?t=${Date.now()}`);
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    } catch {
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadFile(`/products/${productId}/image`, file);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : L('تعذر رفع الصورة.', 'The image could not be uploaded.'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/products/${productId}/image/remove`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : L('تعذر حذف الصورة.', 'The image could not be removed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="item-image" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, overflow: 'hidden' }}>
      {url ? (
        <img src={url} alt={sku} style={{ maxWidth: '100%', maxHeight: 120, objectFit: 'contain' }} />
      ) : (
        <>
          <span className="item-image-initials">{sku.slice(0, 2).toUpperCase()}</span>
          <span className="item-image-caption">{L('لا توجد صورة للصنف', 'No image for this item')}</span>
        </>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => void onPick(e.target.files?.[0])} />
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
            {url ? L('تغيير الصورة', 'Change image') : L('إضافة صورة', 'Add image')}
          </button>
          {url && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void onRemove()}>
              {L('حذف', 'Remove')}
            </button>
          )}
        </div>
      )}
      {error && <span className="error-text" style={{ fontSize: '0.75rem' }}>{error}</span>}
    </div>
  );
}
