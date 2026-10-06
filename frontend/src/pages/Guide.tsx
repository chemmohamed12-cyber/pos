import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CommonTasks } from '../components/CommonTasks';
import { useLanguage } from '../context/LanguageContext';
import { loadPolicyProgress, loadStepStatus, PROCESS_FLOWS, SETUP_STAGES, type GuideStep } from '../lib/guide';

/**
 * NAV-01 / NAV-09 — Setup & Process Guidance: the usual setup order of a Company and the main end-to-end process chains, each step a link to an
 * existing screen, with a done / to-do hint read from the existing list endpoints. Guidance only: nothing here changes data or blocks an operation.
 */
export function Guide() {
  const { t, preload } = useLanguage();
  const [status, setStatus] = useState<Record<string, 'done' | 'todo' | 'unknown'>>({});
  const [policy, setPolicy] = useState<{ ok: number; total: number } | null>(null);

  const allSteps = [...SETUP_STAGES.flatMap((s) => s.steps), ...PROCESS_FLOWS.flatMap((f) => f.steps)];
  preload([
    'nav.guide',
    'panel.guide_intro',
    'panel.guide_setup_title',
    'panel.guide_flows_title',
    'value.guide_status.done',
    'value.guide_status.todo',
    ...SETUP_STAGES.map((s) => s.titleCode),
    ...PROCESS_FLOWS.map((f) => f.titleCode),
    ...allSteps.map((s) => s.labelCode),
  ]);

  useEffect(() => {
    loadStepStatus().then(setStatus);
    loadPolicyProgress().then(setPolicy);
  }, []);

  function badge(step: GuideStep) {
    let state: 'done' | 'todo' | 'unknown' = step.check ? status[step.check] ?? 'unknown' : 'unknown';
    if (step.to === '/accounting/policy') state = policy ? (policy.ok === policy.total ? 'done' : 'todo') : 'unknown';
    if (state === 'unknown') return null;
    const suffix = step.to === '/accounting/policy' && policy ? ` (${policy.ok}/${policy.total})` : '';
    return (
      <span className={`status-badge${state === 'done' ? '' : ' negative'}`} data-testid={`guide-status-${state}`}>
        {t(`value.guide_status.${state}`)}
        {suffix}
      </span>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.guide')}</h1>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ margin: 0 }}>{t('panel.guide_intro')}</p>
      </div>

      <CommonTasks />

      <h2>{t('panel.guide_setup_title')}</h2>
      {SETUP_STAGES.map((stage, i) => (
        <div key={stage.key} className="card" style={{ marginBottom: 12 }} data-testid={`guide-stage-${stage.key}`}>
          <h3 style={{ marginTop: 0 }}>
            {i + 1}. {t(stage.titleCode)}
          </h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {stage.steps.map((s) => (
              <span key={s.labelCode} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Link className="btn btn-secondary" to={s.to}>
                  {t(s.labelCode)}
                </Link>
                {badge(s)}
              </span>
            ))}
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 28 }}>{t('panel.guide_flows_title')}</h2>
      {PROCESS_FLOWS.map((flow) => (
        <div key={flow.key} className="card" style={{ marginBottom: 12 }} data-testid={`guide-flow-${flow.key}`}>
          <h3 style={{ marginTop: 0 }}>{t(flow.titleCode)}</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {flow.steps.map((s, i) => (
              <span key={`${s.labelCode}-${i}`} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <Link className="btn btn-secondary" to={s.to}>
                  {t(s.labelCode)}
                </Link>
                {i < flow.steps.length - 1 && <span aria-hidden>→</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
