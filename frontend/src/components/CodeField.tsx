import { currentLang } from '../lib/displayNames';

/** The code input of a create form: prefilled with the automatic serial, editable, with a one-click way back to the automatic code. */
export function CodeField({
  label,
  value,
  onChange,
  defaultCode,
  isCustom,
  onUseDefault,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  defaultCode: string;
  isCustom: boolean;
  onUseDefault: () => void;
}) {
  const ar = currentLang() === 'ar';
  return (
    <div className="form-field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={64} dir="ltr" style={{ textAlign: ar ? 'right' : 'left' }} data-testid="code-field" />
      <small style={{ display: 'block', opacity: 0.75, marginTop: 2 }}>
        {isCustom ? (
          <>
            {ar ? 'رمز مخصص — لا يُقبل رمز مكرر. ' : 'Custom code — a duplicate is refused. '}
            {defaultCode && (
              <button type="button" className="btn btn-link" style={{ padding: 0 }} onClick={onUseDefault}>
                {ar ? `استعادة التلقائي (${defaultCode})` : `Use the automatic code (${defaultCode})`}
              </button>
            )}
          </>
        ) : ar ? (
          'رمز تلقائي تسلسلي — يمكنك تعديله'
        ) : (
          'Automatic serial — you can change it'
        )}
      </small>
    </div>
  );
}
