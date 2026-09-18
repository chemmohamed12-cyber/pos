#!/usr/bin/env node
/**
 * Structural conformance validator — Daii Stage 2, build-order item 1.
 *
 * Ported and adapted from XNEXUS RMS Step 30's `validate-structure.js`
 * (Daii/_source-audits/rms-step30/, Class A extraction). Adapted for
 * Daii's vocabulary: "modules"/"kernel" -> "domains"/"foundation".
 *
 * Checks two conventions actually in use in this repository:
 *   - Business Domains (src/domains/*): exactly the frozen four layers
 *     (domain/application/infrastructure/interface), no extras.
 *   - Foundation submodules (src/foundation/*): flat — no layer
 *     sub-folders, per Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md.
 *
 * Read-only. Exits non-zero on any violation, with a specific reason
 * per violation.
 *
 * Usage: node tools/validation/validate-structure.js
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOMAINS_ROOT = path.join(REPO_ROOT, 'src', 'domains');
const FOUNDATION_ROOT = path.join(REPO_ROOT, 'src', 'foundation');
const REQUIRED_DOMAIN_LAYERS = ['domain', 'application', 'infrastructure', 'interface'];

// Disclosed, reasoned exceptions (Governance Rule 5: "every architecture
// discrepancy must be disclosed, not quietly resolved" — see
// MASTER_ARCHITECTURE.md's structural-conformance note). Each entry names
// exactly which required layer(s) a domain is allowed to omit and why,
// so the exception is explicit and reviewable, not a silent carve-out.
const DOMAIN_MISSING_LAYER_EXCEPTIONS = {
  // Read-only aggregator over other domains' own data — owns no entities
  // and no persistence of its own, so a `domain`/`infrastructure` layer
  // would be an empty, unlabeled stub with no real content to hold.
  reports: ['domain', 'infrastructure'],
  // Thin CRUD-around-a-profile domain (createSalesRepProfile/
  // getSalesRepProfile/isSalesRep only) with no business rules or
  // invariants of its own to hold a `domain` layer's worth of code.
  sales: ['domain'],
};

// Same idea for Foundation submodules that are structurally layered like
// a Business Domain despite living under foundation/.
const FOUNDATION_LAYER_EXCEPTIONS = {
  // The QR Platform connector integration genuinely outgrew "flat
  // Foundation submodule" — per-connector mapping/pairing/encryption
  // logic benefits from the same domain/application/infrastructure/
  // interface separation a Business Domain gets. Kept under foundation/
  // rather than moved to domains/ to avoid an import-path-breaking
  // rename this close to release for a purely organizational question;
  // revisit as a dedicated reclassification task if that boundary ever
  // becomes load-bearing (see MASTER_ARCHITECTURE.md).
  integrations: ['domain', 'application', 'infrastructure', 'interface'],
};

function dirsIn(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function validateBusinessDomains() {
  const violations = [];
  for (const name of dirsIn(DOMAINS_ROOT)) {
    const domainDir = path.join(DOMAINS_ROOT, name);
    const present = dirsIn(domainDir);
    // Milestone-1 skeletons have no layer folders yet (README-only) —
    // treat "no layers present at all" as not-yet-populated, not a
    // violation, until a domain's build-order item is actually started.
    if (present.length === 0) continue;
    const excusedMissing = DOMAIN_MISSING_LAYER_EXCEPTIONS[name] || [];
    const missing = REQUIRED_DOMAIN_LAYERS.filter((l) => !present.includes(l) && !excusedMissing.includes(l));
    const extra = present.filter((l) => !REQUIRED_DOMAIN_LAYERS.includes(l));
    if (missing.length > 0) violations.push(`domains/${name}: missing required layer(s): ${missing.join(', ')}`);
    if (extra.length > 0) violations.push(`domains/${name}: unexpected extra folder(s): ${extra.join(', ')} (only ${REQUIRED_DOMAIN_LAYERS.join('/')} permitted)`);
  }
  return violations;
}

function validateFoundationModules() {
  const violations = [];
  for (const name of dirsIn(FOUNDATION_ROOT)) {
    if (name.startsWith('__')) continue;
    const moduleDir = path.join(FOUNDATION_ROOT, name);
    const subdirs = dirsIn(moduleDir);
    const excusedLayers = FOUNDATION_LAYER_EXCEPTIONS[name] || [];
    const layerLike = subdirs.filter((d) => REQUIRED_DOMAIN_LAYERS.includes(d) && !excusedLayers.includes(d));
    if (layerLike.length > 0) {
      violations.push(`foundation/${name}: contains Business-Domain-style layer folder(s) (${layerLike.join(', ')}) — Foundation submodules must stay flat.`);
    }
  }
  return violations;
}

if (require.main === module) {
  const violations = [...validateBusinessDomains(), ...validateFoundationModules()];
  if (violations.length === 0) {
    console.log('validate:structure — no violations found.');
    process.exit(0);
  }
  console.error(`validate:structure — ${violations.length} violation(s) found:\n`);
  violations.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
}

module.exports = { validateBusinessDomains, validateFoundationModules };
