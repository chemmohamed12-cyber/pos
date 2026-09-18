# ADR-002 — Backend Stack

**Status:** ACCEPTED (2026-08-22, Stage 1.1 Final Closure)
**Date:** 2026-08-22
**Full evaluation:** `planning/stage-1/STAGE_1_STACK_DECISION.md`

## Closure Note (Stage 1.1 Final Closure Directive)

This ADR was left PROPOSED pending explicit confirmation of team NestJS/TypeScript capability — an organizational input outside this discovery's evidence base. The Stage 1.1 Final Closure directive states "The architecture direction is accepted" and proceeds directly to a Stage 2 build order whose second step is "Backend stack," without further deliberation on the option. **This is treated as CTO acceptance of the Stage 1 stack recommendation** (NestJS + TypeScript + PostgreSQL) and this ADR is finalized accordingly — disclosed explicitly here, per governance rule 5, rather than silently assumed. If this interpretation is incorrect, this is the one line item to correct before further Stage 2 code depends on it.

## Context

`baseline/` and `xnexus-website/` (the two sources with genuinely valuable, extractable business-domain patterns — Process Engine, Inventory Ledger, Delivery Dispatch, Geography, Permission/Limit) are plain Node/Express/JavaScript. `30/` (the source with the strongest governance discipline and one genuinely solid primitive — the Audit hash-chain) is NestJS/TypeScript. No source's stack can be adopted "for free" — nearly every extraction candidate in the matrix is Class C (extract concept) or D (rebuild), meaning the source language is rarely the limiting factor either way.

## Decision

**Recommend NestJS + TypeScript + PostgreSQL**, with the explicit caveat that this recommendation assumes the implementation team has or can acquire NestJS/TypeScript proficiency — an input this discovery process cannot audit from source code alone.

Rationale (full detail in the stack decision report):
1. Blueprint §41 mandates strict domain boundaries and "no domain leakage" — TypeScript's static typing plus NestJS's DI/module system support enforcing this at compile time and via lint rules, exactly as RMS's ADR-006 boundary rule demonstrated is achievable in this stack.
2. Daii is a multi-year, multi-domain ERP-scale platform (eventually including Finance Phase 2) — type safety's payoff compounds as domain count grows, and several defect classes found in the audits (untyped role arrays, ad hoc permission checks, `fetch()` not rejecting on 4xx/5xx) are exactly the class of error static typing and stricter tooling catch earlier.
3. The one source module confirmed NOT to be a stub — RMS's Audit hash-chain — is already TypeScript, and its generator/structure-validator tooling is stack-agnostic either way (Class A regardless of ADR-002's outcome).
4. Almost no literal business-logic code ports verbatim from any source regardless of stack (dominant classifications are C/D) — so the "two sources are JS" argument is weaker than it first appears; the rewrite cost is similar either way.

## Consequences

- If accepted: RMS's kernel code (audit, event-bus interface, generator/validator tooling) becomes a legitimate starting skeleton, not just a pattern reference.
- If the team lacks NestJS/TS capacity, Express + TypeScript (or even Express + JS, accepting weaker boundary enforcement and compensating with stricter code review discipline) is a credible fallback — see the stack decision report's Option comparison.
- This ADR is **not marked ACCEPTED** because team capability is an organizational input outside this discovery's evidence base — a CTO/human decision is required to finalize it.
