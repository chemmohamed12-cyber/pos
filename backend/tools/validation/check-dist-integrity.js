#!/usr/bin/env node
// Verifies every relative require() in dist/**/*.js resolves to an actual
// file on disk. Run after `npm run build`, before packaging a release.
const fs = require('fs');
const path = require('path');

const distRoot = path.join(__dirname, '..', '..', 'dist');
const requireRe = /require\(\s*["'](\.[^"')]+)["']\s*\)/g;

function resolveCandidate(baseDir, spec) {
  const abs = path.resolve(baseDir, spec);
  const candidates = [
    abs,
    abs + '.js',
    path.join(abs, 'index.js'),
  ];
  return candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

if (!fs.existsSync(distRoot)) {
  console.error(`dist/ not found at ${distRoot} — run npm run build first.`);
  process.exit(2);
}

const files = [];
walk(distRoot, files);

let checked = 0;
const missing = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const baseDir = path.dirname(file);
  let m;
  while ((m = requireRe.exec(src)) !== null) {
    checked += 1;
    const spec = m[1];
    if (!resolveCandidate(baseDir, spec)) {
      missing.push({ file: path.relative(distRoot, file), spec });
    }
  }
}

console.log(`Checked ${checked} relative require() calls across ${files.length} dist files.`);
if (missing.length) {
  console.error(`\nFAIL — ${missing.length} unresolved require() target(s):`);
  for (const { file, spec } of missing) {
    console.error(`  dist/${file} -> "${spec}"`);
  }
  process.exit(1);
}
console.log('PASS — every relative require() in dist resolves to a real file.');
