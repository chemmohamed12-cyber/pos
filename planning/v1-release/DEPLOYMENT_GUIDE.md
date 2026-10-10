# Deployment Guide — Daii V1

## Required environment variables (production)

Setting `NODE_ENV=production` triggers strict validation (`configuration.schema.ts`) — the app refuses to boot with a missing or known-dev-default value for any of the starred variables.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PORT` | yes | backend HTTP port |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_NAME` | yes | Postgres connection |
| `DB_PASSWORD` * | yes | real value; the literal `daii_dev_only` is rejected in production |
| `JWT_ACCESS_SECRET` * | yes | 32+ chars; the dev-default literal is rejected in production |
| `JWT_REFRESH_SECRET` * | yes | 32+ chars; the dev-default literal is rejected in production |
| `INTEGRATION_ENCRYPTION_KEY` * | yes | 32+ chars; the dev-default literal is rejected in production; used for AES-256-GCM encryption of stored integration credentials |
| `JWT_ACCESS_TTL_SECONDS` | no | defaults to 900 (15 min) |
| `JWT_REFRESH_TTL_DAYS` | no | defaults to 30 |
| `MEDIA_STORAGE_PATH` | no | defaults to `./storage/media` |

`.env.example` currently only lists the DB_* variables — see `KNOWN_LIMITATIONS.md` item 10.

## Migration sequence

```bash
cd backend
npm run migration:run
```

70 migrations, forward-only, idempotent (safe to run repeatedly — `migration:run` reports "No migrations are pending" once caught up). No `synchronize` is used anywhere; schema changes only ever happen through migrations.

## Build

```bash
# Backend
cd backend
npm run build          # nest build -> dist/

# Frontend
cd frontend
npm run build           # tsc -b && vite build -> dist/
```

## Start

```bash
cd backend
node dist/main.js
```

Serve `frontend/dist/` behind your web server / reverse proxy of choice, proxying `/api` to the backend.

## Health checks

- `GET /api/health` — shallow boot-proof (process is up).
- `GET /api/health/db` — database connectivity.
- `GET /api/health/deep` — full component health.

## Smoke tests (run after every deploy)

1. `POST /api/auth/login` with the bootstrap admin — confirm `200`.
2. `GET /api/admin/users` with that token — confirm `200` (admin-gated route reachable).
3. Create a sales order for a product/warehouse with known stock — confirm reservation reflected in the Inventory Grid.
4. Attempt an order with quantity exceeding available stock — confirm `409`, no order created.
5. Post a warehouse transaction — confirm ledger movement and correct on-hand/reserved/available figures.
6. `POST /api/auth/register` with no token — confirm `401` (not `201`) once at least one user exists.

## First deployment / bootstrap

With zero users in the database, `POST /auth/register` is open (no auth required) and the first registered user automatically becomes `admin`. Every registration after that requires an authenticated admin caller.
