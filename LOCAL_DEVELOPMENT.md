# Daii — Local Development Setup

The shortest reliable path to a running Daii instance on a developer's
own machine: real PostgreSQL, real migrations, real backend, real UI.
No Docker required, no manual table creation, no raw-API console needed
for normal use.

## Prerequisites

- Node.js 20+ and npm
- PostgreSQL 16 — three ways to get it, pick whichever fits:
  - **Already have Postgres installed/running locally?** Skip to
    [Database setup](#2-database-setup) and just point `.env` at it.
  - **Have Docker?** `cd backend && docker compose up -d` starts a
    disposable Postgres 16 container on port 5432 with the exact
    user/password/database `.env.example` already expects — skip
    straight to [Database setup](#2-database-setup) after that.
  - **No Docker, don't want to install a system service?** Use the
    portable (no-installer, no admin rights, no Windows service)
    binaries — see [Portable PostgreSQL](#portable-postgresql-windows-no-installer)
    below. This is what this project's own development has used.

## 1. Portable PostgreSQL (Windows, no installer)

Skip this section if you already have a Postgres server to point at.

1. Download the **binaries-only** zip for PostgreSQL 16 for Windows
   x86-64 from [EDB's PostgreSQL Windows binaries page](https://www.enterprisedb.com/download-postgresql-binaries)
   (~340MB). This is a plain zip, not the installer — no admin rights
   needed, doesn't register a Windows service.
2. Extract it anywhere, e.g. `C:\pgsql`. You should have `C:\pgsql\bin\`,
   `C:\pgsql\lib\`, etc.
3. Initialize a data directory (one-time):
   ```bash
   C:\pgsql\bin\initdb.exe -D C:\pgsql\data -U daii -A trust
   ```
4. Start the server (foreground) or as a background task:
   ```bash
   C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\data\server.log -o "-p 5432" start
   ```
5. Create the database:
   ```bash
   C:\pgsql\bin\createdb.exe -U daii -h 127.0.0.1 -p 5432 daii_dev
   ```

To stop it later: `C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data stop`.
**Never `taskkill` a `postgres.exe` process by name** — always stop it
through `pg_ctl stop`, or by the exact PID if you started it directly;
a hard-killed Postgres can leave the data directory in a state that
needs recovery on next start.

## 2. Database setup

```bash
cd backend
cp .env.example .env
```

The defaults in `.env.example` already match a portable-Postgres setup
started as above (`DB_HOST=localhost`, `DB_PORT=5432`, `DB_USER=daii`,
`DB_PASSWORD=daii_dev_only`, `DB_NAME=daii_dev`) — adjust only if your
Postgres instance differs. **`PORT=3500` must stay 3500** —
`frontend/vite.config.ts` hardcodes its dev-server proxy target to
`http://localhost:3500`; running the backend on any other port makes
the frontend unable to reach the API at all.

Run migrations (creates every table — no manual schema work, ever):

```bash
npm install
npm run migration:run
```

## 3. Backend

```bash
npm run build
npm start
```

Confirm it's healthy:

```bash
curl http://localhost:3500/api/health/deep
# {"success":true,"data":{"status":"ok","components":[{"name":"database","healthy":true}]}}
```

(`npm run start:dev` also works, for auto-restart on file changes.)

## 4. Frontend

```bash
cd ../frontend
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`). The app
talks to the backend through Vite's dev proxy — no CORS setup needed.

## 5. Log in

The real Daii UI is the React app above — not the raw API and not any
demo console. Log in with one of the seeded local accounts documented
in [`LOCAL_DEV_CREDENTIALS.md`](LOCAL_DEV_CREDENTIALS.md) (admin, sales
rep, supervisor, manager, warehouse worker, driver — all local-only,
never for production). If you're on a completely fresh database with no
users yet, that same document's "Reproducing this on a fresh database"
section walks through the bootstrap: the very first `/auth/register`
call becomes admin automatically, then that admin assigns roles to the
rest through the Admin screen (or the same document's `curl` sequence).

## Troubleshooting

- **Frontend loads but every request fails / network errors**: backend
  isn't on port 3500, or isn't running. Check `.env`'s `PORT`.
- **Backend won't start, complains about the database**: confirm
  Postgres is actually listening on the host/port in `.env`
  (`curl` won't tell you; try `psql` or just check `netstat`), and that
  `npm run migration:run` completed without error.
- **Backend starts but `/health/deep` reports the database unhealthy**:
  same as above — the app can reach *a* Postgres, but not the right
  one, or the `daii_dev` database doesn't exist yet (`createdb`, step 1.5).
- **Stopping the backend or Postgres**: always target the exact PID
  that process is running as (check with `netstat -ano` for the port,
  then stop that PID specifically) — never a process-name-wide kill.
  This matters more than it sounds: a process-name kill on a shared
  development machine can take down an unrelated process that happens
  to share the same executable name.
