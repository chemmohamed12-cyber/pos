# ADR-015 — Deployment Model Independence

**Status:** PROPOSED — one open question flagged below requires human/CTO input
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md` §4, `architecture/DAII_PLATFORM_GRADE_CAPABILITY_STANDARD.md` §2.14

## Context

Stage 1's architecture (`DAII_DATA_ARCHITECTURE.md` §2) implicitly assumed a single, cloud-hosted deployment target — PostgreSQL, S3-compatible object storage, Redis, all described without qualification as "the" recommendation. Stage 1.1's purpose statement explicitly requires Daii to support future On-Premise deployment and internal LAN deployment with multiple concurrent users, alongside Cloud, and potentially Hybrid. No Stage 1 document evaluated any capability against this axis — it is new scope, not a gap in prior analysis.

## Decision

Every infrastructure dependency (object storage, cache, background job queue, notification channel transport, secrets source) is accessed through an abstract port; a concrete adapter is selected per deployment target at composition/configuration time, never hardcoded into a capability. The relational database itself (PostgreSQL) does not require this abstraction at the engine level — the same DB engine runs self-hosted on-prem/LAN or managed in the cloud; only its connection/ops configuration varies. See the port/adapter table in `DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md` §4.

This generalizes ADR-006's domain-boundary discipline (Business Modules never import Kernel internals directly) to a second axis: **capabilities never import a specific infrastructure SDK directly** — only their own Foundation-defined port.

## An Open Question This ADR Surfaces Rather Than Resolves

Stage 1's ADR (extraction matrix, RMS: License-context row) explicitly **rejected** RMS's per-installation software-licensing kernel module, reasoning "Daii is a hosted B2B platform, not licensed/sold per-installation software." **On-premise deployment reopens this question**: if Daii is installed at a customer's own site rather than accessed as a hosted service, some form of installation/activation/license-boundary concern may become relevant again in a way it wasn't for a pure SaaS model — not necessarily RMS's specific machine-fingerprint/HMAC-artifact mechanism (which remains a poor fit regardless, being MINIMUM-FOUNDATION-STUB-adjacent even in its own source), but the *category* of concern it addressed.

**This ADR does not resolve that question.** It is flagged here, disclosed rather than silently answered either way, per governance rule 5. Resolving it requires a business decision (does Daii intend to license on-premise installations commercially, or only deploy them for a single owned/controlled business) that is outside this architecture process's evidence base.

## Consequences

- Every Shared-Engine candidate (per `DAII_REUSABLE_PLATFORM_CAPABILITY_CONTRACT.md` §5) is scored on Deployment Independence (Standard §2.14) — most score L0/not-yet-evaluated today, since this axis is new; this is expected and tracked in the maturity scorecard, not a defect in Stage 1's prior work.
- A small on-prem/LAN deployment should not be forced to stand up a full Redis cluster for a single-warehouse operation — the Postgres-backed queue adapter (`pg-boss` or equivalent) exists specifically to keep the on-prem deployment footprint proportionate.
- Notification channel behavior when an on-prem site has restricted/no internet reachability to cloud email/SMS/WhatsApp providers is an **unresolved design question**, not silently assumed to work identically — added to the Stage 1.1 risk register.
- This ADR does not change ADR-002 (stack) or ADR-003 (database engine choice) — it adds a requirement on top of both, not a replacement for either.
