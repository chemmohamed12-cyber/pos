# Daii API Architecture

Status: **DRAFT — Stage 1 Planning.**

---

## 1. Principles

- **Contract-driven, domain-owned** (blueprint §41 principle 15): every API endpoint belongs to exactly one domain (`DAII_DOMAIN_BOUNDARIES.md`); no endpoint reaches across domains internally — it composes via published queries only.
- **Language-neutral contracts** (blueprint §38): canonical codes/enums in every request/response, never localized strings as data. Localized labels are a separate, explicit lookup against the Terminology Registry, never baked into a status field.
- **Server as sole source of truth** (validated pattern from both `baseline`'s mobile-API layer and `xnexus-website`'s thin mobile shells): clients never compute totals, statuses, or permissions locally and submit them as fact — every mutation is re-validated and re-computed server-side.

## 2. Response Envelope

Adopted from `baseline`'s mobile API pattern (`server-mobile-api.js`, `server-mobile-execution-api.js`, `server-mobile-planning-api.js` — Class B), generalized to every Daii endpoint, not just mobile:

```json
// Success
{ "success": true, "data": { ... }, "meta": { "correlationId": "...", "page": {...} } }

// Failure
{ "success": false, "error": { "code": "ORDER_NOT_FOUND", "message": "...", "details": {...} }, "meta": { "correlationId": "..." } }
```

- `error.code` is a **canonical code** (Terminology Registry-eligible), never a free-text string alone — mirrors blueprint §37's "no hard-coded language" rule applied to errors, not just business statuses.
- `meta.correlationId` ties every response back to its Audit Engine record (`DAII_EVENT_ARCHITECTURE.md` §3).
- Stack traces, internal IDs, and raw DB errors are never present in any response (`DAII_SECURITY_ARCHITECTURE.md` §5 discipline extended to error responses).

## 3. Authentication & Authorization on Every Route

Every route declares, explicitly (not by omission):
- Required authentication (none / optional / required) — mirrors `baseline`'s explicit `requireAuth`/`optionalAuth` two-tier distinction (Class B pattern, adopted directly).
- Required Permission node.
- Scope-filtering behavior for list endpoints (server-derived filter, never a client-supplied "show me my customers" parameter trusted as-is).

## 4. Versioning

- URL-path versioned (`/api/v1/...`), following `baseline`'s existing convention (`server-mobile-api.js` already uses `/api/v1/mobile/*`) rather than header-based versioning — simpler to reason about across web, mobile, and future external-API consumers (blueprint §9's "External API" future sales channel).
- Breaking changes require a new version path; canonical codes and event schemas are versioned independently (see `DAII_EVENT_ARCHITECTURE.md` §5).

## 5. Mobile as a Thin Adapter, Not a Parallel API

Both `baseline` (mobile API wraps the same admin Engines) and `xnexus-website` (thin Capacitor shells over one `www/index.html` each, zero client business logic) independently converge on the same correct pattern: **mobile consumes the same domain commands/queries as web, through a thin, mobile-optimized envelope** — never a separately-maintained parallel implementation of business logic. Adopted directly as Daii's mobile API strategy (`DAII_MOBILE_ARCHITECTURE.md`).

## 6. Idempotency

Every mutating endpoint that could plausibly be retried (order submission, offer accept, deposit submission, delivery outcome recording) accepts an idempotency key and returns the original result on a duplicate request rather than creating a second record. This is the API-layer backstop for the client-side duplicate-submission guard required in `DAII_SECURITY_ARCHITECTURE.md` §4 — belt-and-suspenders, since the client-side guard alone was exactly what failed in `xnexus-website`'s one documented incident.

## 7. Rate Limiting & Response Caching

- Rate limiting: `xnexus-website/rate-limiter.js`'s dependency-free in-memory sliding-window implementation is directly reusable (Class A) for an early single-instance deployment; documented upgrade path to a Redis-backed limiter once Daii runs multiple instances (`DAII_DATA_ARCHITECTURE.md` §2).
- Response caching: `xnexus-website/response-cache-engine.js`'s tiny in-memory Map cache (invalidate-on-write) is similarly reusable as-is (Class A) for the same early-stage window.

## 8. What This Document Does Not Do

No actual endpoint implementations, OpenAPI/Swagger specs, or route handlers are created here — per the CTO directive's Stage 1 constraint. Per-domain detailed API contracts are deferred to `architecture/api/` sub-documents in a later planning pass, once the stack decision (ADR-002) is accepted and a concrete framework's routing conventions can be assumed.
