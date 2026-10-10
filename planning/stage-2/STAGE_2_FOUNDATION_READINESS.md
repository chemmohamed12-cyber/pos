# Stage 2 — Foundation Readiness Tracker

Status: **ACTIVE.** Updated as each Phase A build-order item completes. Not a duplicate of Stage 1.1's architecture readiness (which asks "is this designed") — this tracks "is this built and tested."

---

| # | Item | Design Status (Stage 1.1) | Build Status | Notes |
|---|---|---|---|---|
| 1 | Repository / project structure | ACCEPTED | **Complete** | Milestone 1 |
| 2 | Backend stack bootstrap | ACCEPTED (ADR-002) | **Complete** | Milestone 1 — NestJS + TypeScript, build/lint/boot verified |
| 3 | PostgreSQL foundation | ACCEPTED (ADR-003) | **Complete (code); live E2E pending environment)** | Milestone 2 — TypeORM + migrations wired and correct; no Postgres reachable in this sandbox (no Docker), confirmed by a genuine ECONNREFUSED+retry, not a silent no-op. Real integration verification required once Postgres is reachable, before anything with live concurrency/transaction dependence ships. |
| 4 | Configuration Engine | ACCEPTED | **Complete** | Milestone 3 — env validation (Joi), typed access facade, fail-closed on missing required vars and on the dev-secret default in production; 4 unit tests passing |
| 5 | Identity | ACCEPTED | **Complete** | Milestone 4 — `User` entity + migration, UsersService (create/findById/findByEmail), 4 unit tests. No credential fields (Authentication's table, item 6) |
| 6 | Authentication | ACCEPTED (ADR-004) | **Complete** | Milestone 5 — Credential+RefreshToken entities/migrations, bcrypt hashing, JWT access+refresh, rotation, reuse-detection (family revocation), fail-closed prod secrets, JwtAuthGuard (required-tier only, optional-tier deferred/YAGNI). 10 security-focused tests |
| 7 | Authorization | ACCEPTED (ADR-005) | **Complete** | Milestone 6 — Role/UserRole entities+migration (6 V1 roles seeded as data, not hardcoded), AuthorizationService, RolesGuard+@RequireRole decorator. 5 tests |
| 8 | Permission Engine | ACCEPTED | **Complete** | Milestone 7 — ancestor-walk resolution, deny-by-default, 404-not-403. 7 tests |
| 9 | Scope Engine | ACCEPTED | **Complete** | Milestone 8 — no source, full build. Direct assignment + admin unrestricted-scope override. 7 tests |
| 10 | Organization | ACCEPTED | **Complete** | Milestone 9 — self-referential OrgUnit tree, no hardcoded single-company assumption. 5 tests |
| 11 | Audit | ACCEPTED (ADR-012/017) | **Complete (logic); DB-lock concurrency pending environment** | Milestone 10 — RMS hash-chain algorithm ported, `verifyChain()` for backup integrity (ADR-020 §3). Pure-logic hash + chain-walk tests pass (7 new); the transactional row-lock on concurrent writers needs live-Postgres integration verification |
| 12 | Events (outbox) | ACCEPTED (ADR-012) | **Complete** | Milestone 11 — transactional publish(), dispatchPending() with per-event failure isolation + dead-letter-by-status. 4 tests |
| 13 | Error Contract | ACCEPTED (ADR-017) | **Complete** | Milestone 12 — DaiiException, AllExceptionsFilter (no leaked internals), ResponseEnvelopeInterceptor, CorrelationIdMiddleware. 8 tests |
| 14 | Idempotency | ACCEPTED (ADR-017) | **Complete** | Milestone 13 — explicit opt-in `IdempotencyService.withIdempotency()` (not a transparent interceptor, deliberate simplicity), same-key race resolves to one winner. 4 tests. Placed in `foundation/error-contract/` per Cross-Cutting Spec grouping, not its own Foundation Contract capability |
| 15 | Observability | ACCEPTED (ADR-017) | **Complete** | Milestone 14 — DaiiLoggerService, MetricsService (in-memory, real backend deferred per ADR-016), HealthService (real DB round-trip check, RMS discipline), `/health/deep`. 5 tests |
| 16 | Terminology / i18n | ACCEPTED (ADR-011) | **Complete** | Milestone 15 — TerminologyEntry registry seeded with blueprint §36's own worked example, never-blank fallback, unregistered-code warning (not silence); LocalizationService (Arabic default, zero locale-derivation code). 9 tests |
| 17 | Numbering | ACCEPTED | **Complete** | Milestone 16 — transactional row-locked issuance, year rollover, `reconcileAgainstObservedMax()` (the actual TD-29 fix). 5 tests |
| 18 | Process Engine contract | ACCEPTED (ADR-008) | **Complete** | Milestone 17 — adapted from `baseline` (Class A/B). The real Sales Order Approval Workflow (blueprint §14) defined as data and run end-to-end through the generic engine, including the reject/resubmit branch. 6 tests |
| 19 | Shared infrastructure adapters | ACCEPTED (ADR-019) | **Complete** | Milestone 18 — ObjectStoragePort + LocalFilesystemStorageAdapter (also the real On-Premise/LAN adapter, not throwaway), composition-root port binding pattern established for future ports. 9 tests, including real filesystem I/O |
| 20 | Foundation tests | ACCEPTED (ADR-017) | **Complete** | Confirmed by this tracker itself — every one of items 1-19 has passing, proportional tests (93 total across 22 suites); full suite + lint + structure validator all green as of the last milestone |

## Phase A (Platform Foundation): COMPLETE

All 20 items are Build Status: Complete. Per `STAGE_2_DEFINITION_OF_DONE.md`, Phase A is Done. **One caveat carried forward, not a blocker**: items 3 and 11's concurrency/locking guarantees (Postgres row locks under real concurrent load) are code-correct and unit-verified but have not had live-Postgres integration verification in this sandbox (no Docker/Postgres available) — required before anything with real concurrent-write dependence (Inventory reservation, Shipment Offer-Accept, Sales Order approval races) ships in Phase B, per `STAGE_2_FOUNDATION_READINESS.md`'s own standing note and the CTO Execution Policy's environment-limitation handling (§4: document, don't block, verify when the dependency becomes available).

**Ready to Start Phase B**: this condition is now met.
