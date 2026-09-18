# Daii Frontend

React + TypeScript + Vite. This is the real Daii operational UI — Arabic-first (RTL, `context/LanguageContext.tsx` driving every label through the backend's Terminology Registry), role-aware navigation, and screens covering the full sales-to-delivery cycle plus Excel import/export, printable business documents, and operational reports.

See `../LOCAL_DEVELOPMENT.md` for the full local setup (backend, Postgres, migrations) this app depends on.

## Running

```bash
npm install
npm run dev
```

Opens on Vite's default port (`http://localhost:5173`); its dev-server proxy forwards `/api/*` to the backend on `http://localhost:3500` (see `vite.config.ts`) — the backend must already be running there.

## Structure

```
src/
├── pages/            ← one file per screen (Customers, SalesOrders, Fulfillment, Reports, ...)
│   └── print/          ← printable business documents, all rendered through print/PrintDocument.tsx
├── components/        ← shared UI (Layout/nav, StatusBadge, panels embedded in multiple pages)
├── context/            ← AuthContext (JWT/roles), LanguageContext (Terminology Registry + ar/en + RTL/LTR)
├── print/              ← the shared Document Data Contract + renderer every print page goes through
└── lib/api.ts          ← thin fetch wrapper (JWT header, envelope unwrapping, ApiError)
```

## Build

```bash
npm run build   # tsc -b && vite build
```
