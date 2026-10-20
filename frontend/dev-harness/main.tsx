import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import '../src/index.css';
import '../src/styles/ui.css';
import { LanguageProvider, useLanguage } from './stubLanguage';
import { AuthProvider, ROLES, useAuth } from './stubAuth';
import { TreasuryWorkspace } from '../src/pages/treasury/TreasuryWorkspace';
import { TreasuryDocuments } from '../src/pages/treasury/TreasuryDocuments';
import { TreasuryDocumentForm } from '../src/pages/treasury/TreasuryDocumentForm';
import { TreasuryDocumentDetail } from '../src/pages/treasury/TreasuryDocumentDetail';
import { BankStatements } from '../src/pages/treasury/BankStatements';
import { BankStatementDetail } from '../src/pages/treasury/BankStatementDetail';
import { CashSessions } from '../src/pages/treasury/CashSessions';

function Toolbar() {
  const { role, setRole, user } = useAuth();
  const { lang, setLang } = useLanguage();
  const mode = localStorage.getItem('harness_mode') ?? 'ok';
  return (
    <div id="harness-toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: 8, background: '#fff8dc', borderBottom: '1px solid #ccc', fontSize: 13 }}>
      <strong>UI harness (mock API)</strong>
      <label>
        role{' '}
        <select
          value={role}
          onChange={(e) => {
            localStorage.setItem('harness_uid', JSON.stringify(ROLES[e.target.value].userId));
            setRole(e.target.value);
          }}
        >
          {Object.entries(ROLES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        lang{' '}
        <select value={lang} onChange={(e) => setLang(e.target.value as 'ar' | 'en')}>
          <option value="ar">AR</option>
          <option value="en">EN</option>
        </select>
      </label>
      <label>
        api mode{' '}
        <select
          value={mode}
          onChange={(e) => {
            localStorage.setItem('harness_mode', e.target.value);
            location.reload();
          }}
        >
          {['ok', 'slow', 'error', 'network', 'empty'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <span>user: {user.id}</span>
      <Link to="/treasury/workspace">workspace</Link> · <Link to="/treasury/documents">documents</Link> · <Link to="/treasury/documents/new">new</Link> · <Link to="/treasury/bank-statements">statements</Link> · <Link to="/treasury/cash-sessions">sessions</Link>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <AuthProvider>
        <BrowserRouter>
          <Toolbar />
          <div style={{ padding: 16 }}>
            <Routes>
              <Route path="/treasury/workspace" element={<TreasuryWorkspace />} />
              <Route path="/treasury/documents" element={<TreasuryDocuments />} />
              <Route path="/treasury/documents/new" element={<TreasuryDocumentForm />} />
              <Route path="/treasury/documents/:id/edit" element={<TreasuryDocumentForm />} />
              <Route path="/treasury/documents/:id" element={<TreasuryDocumentDetail />} />
              <Route path="/treasury/bank-statements" element={<BankStatements />} />
              <Route path="/treasury/bank-statements/:id" element={<BankStatementDetail />} />
              <Route path="/treasury/cash-sessions" element={<CashSessions />} />
              <Route path="*" element={<TreasuryWorkspace />} />
            </Routes>
          </div>
        </BrowserRouter>
      </AuthProvider>
    </LanguageProvider>
  </StrictMode>,
);
