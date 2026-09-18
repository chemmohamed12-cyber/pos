# Controlled UUID Data Repair — Rehearsal Result

Ran against an isolated scratch PostgreSQL cluster (NOT staging/production).

| Step | Result |
|---|---|
| Legacy rows injected | via the pre-fix `gen_random_uuid()` (reproduces the prod PG10 state) |
| Audit — non-compliant PKs found | 3 |
| Mapping generated | 3 old→new pairs, all new ids RFC4122 |
| Repair | 3 row(s), one transaction |
| Integrity verification | PASS — 0 non-compliant remaining, 0 failed checks |
| Row-count parity | identical before/after |
| `treasury_accounts` example | `76c30f35-48cb-bc34-86eb-f6ebbad994fb` → `67f8907c-5502-46c1-97c4-7fec3a0d8915` |
| `@IsUUID()` on the repaired id | accepted (old id rejected) |
| Restore/rollback | pre-repair `pg_dump` restored → ids + counts back to pre-repair state |

Environment: Node v26.7.0, PostgreSQL 18 scratch cluster. Production
is Node 20.20.2 / PostgreSQL 10 — the real staging run uses the same
`DataRepairService` flow (`DATA_REPAIR_RUNBOOK.md`).
