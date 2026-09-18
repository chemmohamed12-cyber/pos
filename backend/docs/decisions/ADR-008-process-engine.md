# ADR-008 — Process Engine

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** extraction matrix (Baseline: Process Engine), `architecture/DAII_DOMAIN_BOUNDARIES.md` §4

## Context

`baseline/server/engines/process-engine.js` is a stateless, fully generic approval-workflow engine — `(state, action, actor, excludedActor)` — with no knowledge of "orders," "plans," or any business noun. It is the single highest-confidence extraction candidate found across all three audits and already proven reused twice within `baseline` itself (Planning Center, Execution Runtime).

## Decision

Daii adopts the Process Engine's state-machine shape directly (Class A/B) as the mechanism powering the Sales Order Approval Workflow (blueprint §14: Draft→Submitted→Supervisor Review→Manager Approval→Deposit Verification→Released) and any other configurable approval flow needed later. The workflow definition (states/transitions/actions) is NOT hardcoded into the engine — it remains domain-neutral, consuming a Process Definition per blueprint §41 principle 11 (no giant monolithic module).

## Consequences

- Process Definition, State, Transition, Actor, Permission, Condition, Action, Transition History, Idempotency, Audit hook, and Notification hook are all first-class concepts in the engine's contract (per CTO directive §2.8).
- The engine itself has zero dependencies; persistence (`process_instances`/`process_transitions` tables) is added fresh, not ported (source is stateless already).
- Every transition emits an event (consumed by Audit and Notification) — see `DAII_EVENT_ARCHITECTURE.md`.
