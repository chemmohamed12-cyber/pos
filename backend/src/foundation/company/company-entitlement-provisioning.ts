import { DataSource } from 'typeorm';
import { Installation, INSTALLATION_SINGLETON_ID } from '../entitlement/installation.entity';
import { verifyManifest } from '../entitlement/manifest-verify';
import { EntitlementManifest } from '../entitlement/manifest.type';
import { computeInstallationFingerprint } from '../entitlement/installation-fingerprint';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { DatabaseConfig } from '../configuration/app-config.service';

export interface CompanyEntitlementOptions {
  publicKeys: { kid: string; spki_b64: string }[];
  clockToleranceMinutes: number;
  expandClosure?: boolean;
}

export class CompanyEntitlementRejectedError extends Error {}

/**
 * Multi-Company Phase 3 V7, Area 7 (Edition/Entitlement per Company).
 * V7's own text: "each Company gets its own signed manifest via the
 * exact same, unmodified apply-path." Investigation found
 * `EntitlementService.applyManifest()` is NOT a cleanly parameterizable
 * pure function like Area 16/6's reuse targets — it is entangled with
 * the app's OWN injected `DataSource` (for its transaction), its own
 * `AuditService`, and its own `EventBusService`, none of which are
 * meaningfully parameterizable without either modifying that shared,
 * security-critical class (contradicting "unmodified") or duplicating
 * a lot of unrelated app-level plumbing.
 *
 * What genuinely IS pure and safely reusable, unmodified, is reused
 * here: `verifyManifest` (signature check) and
 * `MODULE_REGISTRY.dependencyClosureOf` (F-MOD-2 dependency-closure
 * check) — the actual security-relevant logic. `computeInstallationFingerprint()`
 * is also reused as-is: it is correctly Installation-scoped, not
 * Company-scoped — every Company under the same Installation legitimately
 * shares the same anti-clone binding, so this is not a new decision,
 * just consistent reuse.
 *
 * What is deliberately NOT done here, and recorded rather than invented:
 * this does not write to `AuditService` or `EventBusService`. Area 14
 * (Company-scoped Audit Trail) is now IMPLEMENTED/REAL-PG VERIFIED/CLOSED
 * (2026-09-25), but its CTO-approved V1 taxonomy is a specific,
 * evidence-grounded list (Membership grant/revoke/role-change, Closing
 * Snapshot completion/overdue, Approval expire) — entitlement application
 * was never in that list, and Area 14's own directive is explicit: do not
 * extend the approved taxonomy unilaterally during unrelated work.
 * Recording this application only in the app's own Control-Plane audit
 * log would be the wrong table for a Company-scoped event; recording it
 * nowhere is honest about that gap rather than guessing. Whether Company
 * entitlement application should join a future Area 14 taxonomy revision
 * is a real, evidence-backed candidate — flagged here, not decided here.
 *
 * The `Installation` entity/table is reused unmodified — every Company
 * database already has this table (it ships with the 'core' migration
 * tag, which every provisioned Company runs). This function writes into
 * THAT Company's own copy of it, interpreting the one singleton row not
 * as "the software installation" but as "this Company's own entitlement
 * manifest" — the exact same row shape, a different physical database.
 */
export async function applyEntitlementManifestToCompany(
  database: DatabaseConfig,
  manifestObj: EntitlementManifest,
  signatureB64: string,
  opts: CompanyEntitlementOptions,
): Promise<void> {
  const result = verifyManifest(JSON.stringify(manifestObj), signatureB64, {
    publicKeys: opts.publicKeys,
    clockToleranceMinutes: opts.clockToleranceMinutes,
    lastTrustedAtMs: null,
    currentFingerprint: computeInstallationFingerprint(),
  });
  if (!result.ok) {
    throw new CompanyEntitlementRejectedError(`Company entitlement manifest rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
  }
  const manifest = result.manifest;

  const requested = new Set(manifest.module_codes);
  const missing = new Set<string>();
  for (const m of manifest.module_codes) {
    for (const dep of MODULE_REGISTRY.dependencyClosureOf(m as never)) {
      if (!requested.has(dep)) missing.add(dep);
    }
  }
  if (missing.size && !opts.expandClosure) {
    throw new CompanyEntitlementRejectedError(
      `Company entitlement manifest enables ${[...requested].join(', ')} but omits their hard dependencies: ${[...missing].join(', ')}.`,
    );
  }

  const dataSource = new DataSource({ type: 'postgres', ...database, entities: [Installation], synchronize: false, logging: false });
  await dataSource.initialize();
  try {
    const repo = dataSource.getRepository(Installation);
    await repo.save(
      repo.create({
        id: INSTALLATION_SINGLETON_ID,
        installationId: manifest.installation_id,
        customerName: manifest.customer_name,
        editionCode: manifest.edition_code,
        editionVersion: manifest.edition_version,
        status: 'active',
        termStart: manifest.term_start ? new Date(manifest.term_start) : null,
        termEnd: manifest.term_end ? new Date(manifest.term_end) : null,
        graceDays: manifest.grace_days ?? 0,
        entitlementManifest: manifest,
        manifestSignature: signatureB64,
        manifestKid: manifest.kid,
        issuedAt: new Date(manifest.issued_at),
        lastTrustedAt: new Date(),
        verificationState: 'verified',
      }),
    );
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}
