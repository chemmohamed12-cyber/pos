#!/usr/bin/env node
/**
 * Business Domain skeleton generator — Daii Stage 2, build-order item 1.
 *
 * Ported and adapted from XNEXUS RMS Step 30's `generate-module.js`
 * (Daii/_source-audits/rms-step30/, Class A extraction — plain Node.js
 * fs/path, zero framework dependency, confirmed stack-neutral per
 * architecture/extraction/DAII_SOURCE_EXTRACTION_MATRIX.md). Adapted
 * for Daii's own vocabulary: "modules" -> "domains", rooted at
 * backend/src/domains instead of apps/api/src/modules.
 *
 * Generates the frozen four-layer structure — domain/, application/,
 * infrastructure/, interface/ — per Daii/architecture/DAII_DOMAIN_BOUNDARIES.md.
 * Every generated file is a placeholder — no business logic is emitted.
 *
 * Usage: node tools/generators/generate-domain.js <domain-name>
 */
const fs = require('fs');
const path = require('path');

const LAYERS = ['domain', 'application', 'infrastructure', 'interface'];

function generateDomain(domainName, domainsRoot) {
  if (!/^[a-z][a-z0-9-]*$/.test(domainName)) {
    throw new Error(`Invalid domain name "${domainName}" — must be lowercase, kebab-case, starting with a letter.`);
  }
  const domainDir = path.join(domainsRoot, domainName);
  if (fs.existsSync(domainDir)) {
    throw new Error(`Domain directory already exists: ${domainDir}`);
  }
  for (const layer of LAYERS) {
    const layerDir = path.join(domainDir, layer);
    fs.mkdirSync(layerDir, { recursive: true });
    fs.writeFileSync(path.join(layerDir, '.gitkeep'), '');
  }
  return domainDir;
}

if (require.main === module) {
  const domainName = process.argv[2];
  if (!domainName) {
    console.error('Usage: node tools/generators/generate-domain.js <domain-name>');
    process.exit(1);
  }
  const domainsRoot = path.join(__dirname, '..', '..', 'src', 'domains');
  try {
    const created = generateDomain(domainName, domainsRoot);
    console.log(`Created Business Domain skeleton at ${created} (${LAYERS.join('/, ')}/).`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { generateDomain, LAYERS };
