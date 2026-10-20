import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * DEV-ONLY harness (never part of the app build): renders the real Treasury pages with the REAL components and CSS, but with the API, auth and language modules replaced
 * by stubs so the pages can be exercised in a browser with no backend, no database and no login. The stubs live next to this file.
 */
const stubs: Record<string, string> = {
  'lib/api': path.resolve(__dirname, 'mockApi.ts'),
  'context/AuthContext': path.resolve(__dirname, 'stubAuth.tsx'),
  'context/LanguageContext': path.resolve(__dirname, 'stubLanguage.tsx'),
};
const swap: Plugin = {
  name: 'harness-stub-modules',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || importer.includes('dev-harness')) return null;
    for (const [suffix, file] of Object.entries(stubs)) if (/^\.{1,2}\//.test(source) && source.replace(/\.(ts|tsx)$/, '').endsWith(suffix)) return file;
    return null;
  },
};
export default defineConfig({
  root: __dirname,
  plugins: [swap, react()],
  server: { port: 5185, strictPort: true, host: '127.0.0.1', fs: { allow: [path.resolve(__dirname, '..')] } },
});
