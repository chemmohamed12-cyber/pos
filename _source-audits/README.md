# Daii — Source Audit Index

Status: **All three Stage 0 audits COMPLETED.** This is an index only — full reports live in the paths below. Do not duplicate their content here, and do not re-audit the source repositories they cover; every future Daii stage must cite these as evidence rather than repeating discovery.

---

## 1. Baseline Audit

- **Source repository:** `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\baseline\` ("XNEXUS Wireless Hospitality Calling System" — Node/Express ERP: sales, purchase, planning, manufacturing/BOM/assembly/QC, warranty, warehouse)
- **Audit title:** Stage 0 Capability Audit — `baseline/` (XNEXUS Wireless Hospitality Calling System)
- **Audit status:** COMPLETED
- **Role in Daii planning:** Primary source for the Approval Workflow (Process Engine) and Inventory Ledger concepts; secondary source for Organization hierarchy, Numbering, Notification, and generic task/execution lifecycle patterns.
- **Archive location:** [`baseline/DAII_SOURCE_AUDIT_BASELINE.md`](baseline/DAII_SOURCE_AUDIT_BASELINE.md)
- **⚠ DO NOT RE-AUDIT** — use this report as Stage 0 evidence.

## 2. XNEXUS RMS Step 30 Audit

- **Source repository:** `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\30\` (XNEXUS RMS — unrelated project to `baseline/`; NestJS/TypeScript clean-architecture Platform Foundation kernel for an offline-capable POS/restaurant terminal; Business Modules are empty skeletons)
- **Audit title:** XNEXUS RMS (Step 30) — Kernel Capability Audit for Daii Platform
- **Audit status:** COMPLETED
- **Role in Daii planning:** Reference for the Audit Engine (hash-chain), Event Bus interface shape, module-generator/structure-validator tooling, and the governance/documentation culture (disclosed discrepancies, stub labeling, mechanically-enforced boundaries). Confirmed NOT a source of reusable Business Module code (POS/restaurant-specific, empty anyway) or of production-grade Authentication/Authorization (self-labeled stubs).
- **Archive location:** [`rms-step30/XNEXUS_RMS_STEP30_KERNEL_CAPABILITY_AUDIT.md`](rms-step30/XNEXUS_RMS_STEP30_KERNEL_CAPABILITY_AUDIT.md)
- **⚠ DO NOT RE-AUDIT** — use this report as Stage 0 evidence.

## 3. XNEXUS Website / QR Platform Audit

- **Source repository:** `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\xnexus-website\` (folder name is legacy — actually the QR Platform: QR-menu/CMS + Consumer Discovery + a fully-built Business Delivery Dispatch domain + Permission/Limit entitlement engine)
- **Audit title:** Stage 0 Discovery Audit — QR Platform (`xnexus-website/`)
- **Audit status:** COMPLETED
- **Role in Daii planning:** Highest-value source overall. Primary reference for Fulfillment/Dispatch (Request→Eligibility→Offer→Assignment→Execution), Egypt Geography master data, Permission + Limit Engine, Arabic-first i18n/RTL mechanics, and thin-mobile-client architecture. Also the source of the one documented reliability incident (silent client-side submission failure) carried forward as a Daii reliability requirement.
- **Archive location:** [`xnexus-website/XNEXUS_WEBSITE_QR_PLATFORM_CAPABILITY_AUDIT.md`](xnexus-website/XNEXUS_WEBSITE_QR_PLATFORM_CAPABILITY_AUDIT.md)
- **⚠ DO NOT RE-AUDIT** — use this report as Stage 0 evidence.

---

## Archive Rules

1. These reports are a reference snapshot, not live code documentation — the source repositories may continue to change; these audits are not re-run automatically.
2. Never silently overwrite, shorten, or "correct" these reports. A correction requires a separately approved revision, recorded as such (new dated section or new file, original preserved).
3. Every future extraction decision in `Daii/architecture/extraction/` must cite the specific report + section it draws from, not restate discovery from scratch.
4. Originals also remain at `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\discovery\` (this workspace's Stage 0 working location) — these are byte-identical copies, not the sole record.
