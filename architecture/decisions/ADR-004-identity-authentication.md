# ADR-004 — Identity & Authentication

**Status:** ACCEPTED (principle) — implementation details PROPOSED pending ADR-002
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_SECURITY_ARCHITECTURE.md` §1–2

## Context

No source has production-grade authentication. `baseline` and `xnexus-website` hand-roll HMAC/JWT (the latter duplicated four times across actor types), both with hardcoded dev-secret fallbacks. `30/kernel/authentication` trusts unsigned `x-user-id`/`x-user-roles` headers outright and is self-labeled a stub in its own source comments.

## Decision

Daii builds **one centralized Identity/Authentication Foundation service** — the only component permitted to verify credentials or mint tokens. No domain module implements its own auth. Vetted password hashing (bcrypt/argon2), short-lived signed access tokens, rotatable/revocable refresh tokens, fail-closed startup validation (refuse to start on missing/default secrets), and support for multi-role-per-user, web, mobile (incl. OTP), and service-to-service authentication.

## Consequences

- None of the three sources' authentication code is extracted (all rated Reject/Rebuild for this capability specifically).
- One positive pattern is retained as a design reference: `baseline`'s check against revoked/disabled/stale-password tokens, fail-open only on infrastructure read failure.
- Every domain (Sales, Warehouse, Shipment, etc.) consumes this one service rather than reimplementing auth — directly reverses the 4x-duplication anti-pattern found in `xnexus-website`.
