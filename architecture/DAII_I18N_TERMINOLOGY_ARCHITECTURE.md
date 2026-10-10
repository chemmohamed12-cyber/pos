# Daii i18n & Terminology Architecture

Status: **DRAFT — Stage 1 Planning.**
Covers RTL/LTR mechanics (reused from QR Platform, proven) and the Terminology Registry (built fresh — confirmed gap in all three sources, including the most mature). See ADR-011.

---

## 1. What Is Reused From QR Platform (Class B — proven, working)

Per the QR Platform audit §6, these mechanics work end-to-end in production and are adopted directly:

1. **Arabic is the enforced default on first launch, never derived from device locale.** A Cairo user with an English-locale phone still sees Arabic by default — this directly matches blueprint §34.
2. **Language choice persists via a single, consistently-named preference key** shared across web, CMS, and mobile surfaces.
3. **RTL/LTR is a single `dir` attribute toggle** that works because layouts use flexbox row/space-between rather than hardcoded `left`/`right` — the correct architectural default per blueprint §39 ("do not build the interface as LTR-only and retrofit RTL later"). Direction-aware (not merely mirrored) icon glyphs are part of this pattern.
4. **`t(key)` always falls back to English, never a blank or a raw internal key** — reinforced by a real historical bug the source codebase's own CMS Sidebar Reorganization report caught (`module.ai-management` literally appearing in the UI before its translation key was added). Daii adopts the same never-leak-an-internal-identifier discipline.

## 2. What Is Explicitly NOT Reused — the Terminology Registry Gap

QR Platform's i18n is a **UI-chrome vocabulary layer only** (button labels, module names, "Save"/"Cancel") — not a canonical-code-to-localized-label registry for business domain vocabulary. Its own documentation is candid that raw server-owned status enum values (e.g., `OPEN_FOR_OFFERS`, `ASSIGNED`, `PICKED_UP`) are **deliberately left untranslated and shown verbatim**, explicitly because "localizing them would require maintaining a second, drift-prone mapping never requested."

This is precisely the anti-pattern blueprint §37 warns against (in the mirror direction — never storing the localized string as the canonical value) left unsolved: the source's answer was to simply not localize business values at all, rather than build the registry blueprint §36 specifies. **This is a real gap even in the most mature of the three source platforms and must be built fresh for Daii.**

## 3. Terminology Registry Design

```
TerminologyEntry {
  code: string          // canonical, immutable, e.g. "PENDING_REVIEW"
  category: string       // e.g. "order_status", "warehouse_term", "permission_label"
  ar: string              // Professional Egyptian Business Arabic (see §4)
  en: string              // Professional English business terminology
  version: int
}
```

- **Canonical codes are the only values business logic ever stores or compares against** (blueprint §37: `status = PENDING_REVIEW`, never `status = "بانتظار المراجعة"` or `status = "Pending Review"`).
- **Server-side, API-exposed**: `GET /terminology?lang=ar&category=order_status` returns the resolved label set for a client to render — clients never hardcode label strings for business-domain codes.
- **Fallback behavior**: missing Arabic entry falls back to English (never blank, never the raw code) — same discipline as QR Platform's UI-chrome layer, applied one level deeper.
- **Versioning**: label wording may be revised (e.g., a better Arabic phrasing) without changing the canonical code — existing stored business data referencing the code is unaffected.
- **Ownership**: the Terminology Registry (Foundation Contract §13) is the single owner; no domain defines its own ad hoc label strings for a status it owns — it registers entries and references codes.

## 4. Language Quality Bar (blueprint §34-35, binding)

- **Arabic**: Professional Egyptian Business Arabic. Not literal English translation, not machine-translated Arabic, not heavy legal/formal Arabic, not casual colloquial conversation — should read as if the system were originally designed for Egyptian business users.
- **English**: proper ERP/commerce/warehouse/logistics business terminology, not word-for-word translation from Arabic. Arabic and English are two independently, professionally authored language experiences, not a translation of one into the other.
- Every Terminology Registry entry requires both a professionally-authored `ar` and `en` value at creation — no entry ships with a placeholder or machine-translated value pending "fix later."

## 5. Coverage Required Before Release (blueprint §40, carried forward as an acceptance checklist)

- **Arabic**: full UI coverage, no accidental English leakage, consistent terminology, correct RTL, natural error/status messages, correct reports/notifications.
- **English**: correct professional terminology, natural business language, no literal-translation artifacts, consistent terminology, correct LTR.
- This QA pass applies to every domain's status/label vocabulary registered in the Terminology Registry — order statuses, warehouse terms, shipment/waybill terms, permission labels, and workflow stage names explicitly enumerated (per the CTO directive §2.12): status labels, permission labels, workflow labels, warehouse terminology, sales terminology, shipment terminology.

## 6. What This Document Does Not Do

No Terminology Registry table, seed data, or API implementation is created here — per the CTO directive's Stage 1 constraint. This document is the contract Stage 2 implements against.
