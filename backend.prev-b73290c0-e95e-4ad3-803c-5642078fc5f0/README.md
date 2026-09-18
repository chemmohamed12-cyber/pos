# Daii Backend

NestJS/TypeScript implementation of the Daii Platform Foundation and Business Domains. See `../planning/stage-2/` for the build order and definition of done this code originally followed, and `../LOCAL_DEVELOPMENT.md` for the full local setup walkthrough (Postgres, migrations, backend, frontend).

## Current State

All Phase A (Platform Foundation) and Phase B (Business Domains — Commerce, CRM, Sales, Sales Orders + Approval, Deposit Control, Inventory & Warehouse, Fulfillment, Shipment + Tracking, Delivery, Returns) capabilities are implemented and tested against a real PostgreSQL instance, with an operational React UI (`../frontend/`) covering the full sales-to-delivery cycle, Excel import/export, printable business documents, and cross-domain operational reports.

## Structure

```
backend/
├── src/
│   ├── main.ts, app.module.ts     ← composition root; serves the API under /api
│   ├── database/                   ← DataSource + forward-only migrations (never `synchronize`)
│   ├── foundation/                 ← Platform Core capabilities (auth, authorization, scope, numbering, process engine, excel, terminology, ...)
│   └── domains/                    ← Business Domains, one folder each, 4-layer (domain/application/infrastructure/interface)
├── tools/
│   ├── generators/generate-domain.js   ← ported from RMS (Class A), scaffolds a domain's 4-layer structure
│   └── validation/validate-structure.js ← ported from RMS (Class A), checks folder-shape conformance
├── docker-compose.yml               ← optional Postgres via Docker; ../LOCAL_DEVELOPMENT.md also covers a no-Docker portable setup
└── eslint.config.mjs                ← boundary-enforcement rule (no cross-domain/foundation-internal imports)
```

## Running

See `../LOCAL_DEVELOPMENT.md` for the full walkthrough including Postgres setup. In short, once `.env` and a running Postgres are in place:

```bash
npm install
npm run migration:run
npm run build
npm start
# GET http://localhost:3500/api/health/deep
```

## Governance

Every subsequent change follows `../docs/DAII_ENGINEERING_GOVERNANCE.md` and `../planning/stage-2/STAGE_2_DEFINITION_OF_DONE.md` — no Business Domain code before its Foundation dependencies are marked Complete in `../planning/stage-2/STAGE_2_FOUNDATION_READINESS.md`.
