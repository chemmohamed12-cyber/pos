# ADR-011 — Terminology / Arabic-First

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_I18N_TERMINOLOGY_ARCHITECTURE.md`

## Context

QR Platform proves working Arabic-default/RTL mechanics end-to-end (default-to-Arabic-never-locale-derived, persisted language choice, flexbox-based RTL mirroring, never-blank-fallback labels) but its own documentation admits raw business status enums are deliberately left untranslated rather than registry-mapped — a real gap even in the most mature source.

## Decision

Daii reuses QR Platform's RTL/LTR and default-language mechanics directly (Class B). Daii builds a fresh, server-side, API-exposed **Terminology Registry** (`code → {ar, en}`, versioned) per blueprint §36 — business logic uses canonical codes exclusively; localized labels are a separate, explicit lookup, never domain state.

## Consequences

- Arabic quality bar: Professional Egyptian Business Arabic — not literal translation, not machine translation, not overly formal/legal, not casual. English: proper ERP/commerce/logistics terminology, independently authored, not translated word-for-word from Arabic.
- Every status/label vocabulary (order statuses, warehouse terms, shipment terms, permission labels, workflow stage names) is registered, not hardcoded per-domain.
- Localization QA (blueprint §40) is a release gate, not a nice-to-have.
