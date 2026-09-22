"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatArtifactIntegrityViolations = formatArtifactIntegrityViolations;
exports.verifyArtifactIntegrity = verifyArtifactIntegrity;
const path_1 = require("path");
const promises_1 = require("fs/promises");
const checksum_1 = require("./checksum");
function formatArtifactIntegrityViolations(releaseId, violations) {
    const detail = violations
        .map((v) => `${v.path ?? 'manifest identity'}: expected ${v.expected}, actual ${v.actual}`)
        .join(' | ');
    return `Artifact integrity check failed for release ${releaseId}: ${violations.length} violation(s): ${detail}`;
}
async function verifyArtifactIntegrity(release, candidatePath) {
    const violations = [];
    let candidateManifest = null;
    try {
        const raw = await (0, promises_1.readFile)((0, path_1.join)(candidatePath, 'MANIFEST.json'), 'utf8');
        candidateManifest = JSON.parse(raw);
        const candidateManifestChecksum = (0, checksum_1.computeStringChecksum)(JSON.stringify(candidateManifest));
        if (candidateManifestChecksum !== release.manifestChecksum) {
            violations.push({ kind: 'manifest_identity_mismatch', expected: release.manifestChecksum, actual: candidateManifestChecksum });
        }
    }
    catch (err) {
        violations.push({
            kind: 'manifest_identity_mismatch',
            expected: release.manifestChecksum,
            actual: `MANIFEST.json unreadable/invalid in candidate: ${err instanceof Error ? err.message : String(err)}`,
        });
    }
    for (const f of release.manifest.files) {
        if (f.action === 'delete')
            continue;
        if (!f.checksum)
            continue;
        const filePath = (0, path_1.join)(candidatePath, f.path);
        try {
            const actual = await (0, checksum_1.computeFileChecksum)(filePath);
            if (actual !== f.checksum) {
                violations.push({ kind: 'file_checksum_mismatch', path: f.path, expected: f.checksum, actual });
            }
        }
        catch (err) {
            violations.push({
                kind: 'file_unreadable',
                path: f.path,
                expected: f.checksum,
                actual: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }
    return { releaseId: release.id, ok: violations.length === 0, violations };
}
//# sourceMappingURL=artifact-integrity.js.map