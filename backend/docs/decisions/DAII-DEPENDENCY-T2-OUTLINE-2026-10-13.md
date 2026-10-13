# DAII — Dependency tier T2 (major upgrades): outline and owner request — 2026-10-13

**Status: NOT APPROVED, NOT STARTED.** The CTO directive of 2026-10-13 asks for an **owner** for T2 to be assigned separately and for T2 not to be treated as approved. This page records what T2 is, what it would clear, and what it needs, so the owner can plan. Source: `test-03/DEPENDENCY-AUDIT-D01-2026-10-11.md` §1, §3 and the 2026-10-13 audit (64 advisories after T1; the remaining critical is `tar`, install-time).

| Upgrade (major) | What it would clear (from D-01) | Main risk | Test net needed |
|---|---|---|---|
| NestJS 10 → current major (`core`, `common`, `platform-express`, `config`, `typeorm`, CLI) | multer / body-parser / uuid / `@nestjs/*` advisories, the build-time webpack chain via the CLI | framework API changes across the whole application (guards, interceptors, module metadata, testing utilities); the largest item | business suite, isolation regression, HTTP-level specs, upload-handling specs, a staging run |
| `bcrypt` 5 → 6 | the install-time `tar` critical (via `node-pre-gyp`) | native module rebuild; password-hash compatibility must be proven unchanged (existing hashes must still verify) | authentication specs including a hash-compatibility spec against pre-upgrade hashes |
| `react-router-dom` 6 → 7 (frontend) | open-redirect advisory | routing API changes in the SPA | frontend tests and browser E2E (the frontend test net is thin — roadmap ENB-1) |
| Jest 29 → 30 (dev) | the dev-only Jest tool chain advisories | test-runner behaviour; none in production | the whole unit and integration suite on the new runner |
| T3 — accept with owner | dev-only chains until T2; the install-time `tar` exposure (install only from the trusted registry) | residual | a written risk acceptance by a named owner |

**Owner needed:** `SECURITY_AND_DEPENDENCY_OWNER` for T2 and the T3 acceptances (unassigned; owner request C3). **Pre-conditions before any T2 work starts:** the T1 change merged and verified (done at `8ec6de4`, verification in the execution report); the test net listed per row available; a staging host for the NestJS major (owner request C9); an explicit CTO approval per upgrade — none is given by the T1 approval.
**Plan shape once approved:** one package per change, each in its own commit with its own clean-snapshot CI and regression, rollback by reverting that commit, independent review of the lockfile diff (reviewer ≠ applier).
