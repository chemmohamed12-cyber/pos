import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import { AppModule } from '../../../app.module';
import { FiscalPeriodService } from './fiscal-period.service';
import { ClosingAuditService } from './closing-audit.service';
import { ClosingSnapshotService, ClosingSnapshotManifest } from './closing-snapshot.service';
import { ClosingSnapshotSigningKeyService } from './closing-snapshot-signing-key.service';
import { ClosingSnapshotSigningKey } from '../infrastructure/closing-snapshot-signing-key.entity';
import { ClosingSnapshotRun } from '../infrastructure/closing-snapshot-run.entity';
import { AppConfigService } from '../../../foundation/configuration/app-config.service';
import { canonicalizeJson } from '../../../foundation/crypto/canonical-json';
import { generateEd25519KeyPair, signEd25519 } from '../../../foundation/crypto/ed25519';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';

/**
 * ADR-051 Final Completion Gate (Phase 7): "A historical snapshot remains
 * independently verifiable after signing-key rotation, while the original
 * snapshot remains untouched." A real process restart with a changed
 * `CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY`/`_KID` env var cannot be exercised
 * inside one Jest process (env vars are read once at startup, matching
 * `JWT_ACCESS_SECRET`'s own custody model, ADR-051 §9) — so rotation is
 * simulated the way it actually differs from "not rotated": a SECOND `kid`
 * registered in the append-only registry, used to sign a fabricated
 * "historical" snapshot, while the service's OWN configured key is used to
 * sign a "new" one afterward. `verify()` must succeed for BOTH, looking up
 * whichever `kid` each manifest itself declares — exactly the property
 * that makes rotation safe for existing evidence (ADR-051 §10).
 */
describe('ClosingSnapshotService key rotation and cryptographic failure modes (ADR-051 Phase 7)', () => {
  let moduleRef: TestingModule;
  let fiscalPeriods: FiscalPeriodService;
  let closingSnapshots: ClosingSnapshotService;
  let signingKeys: ClosingSnapshotSigningKeyService;
  let approvals: ApprovalEngineService;
  let appConfig: AppConfigService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const ADMIN_B = '04531f67-b087-4459-93de-55c61da9d66b';
  const shortCode = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`.slice(0, 16);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClosingAuditService)
      .useValue({
        assertCleanForClose: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-00000000f00d', status: 'clean' }),
        run: jest.fn(),
        listRuns: jest.fn().mockResolvedValue([]),
      })
      .compile();
    await moduleRef.init();

    fiscalPeriods = moduleRef.get(FiscalPeriodService);
    closingSnapshots = moduleRef.get(ClosingSnapshotService);
    signingKeys = moduleRef.get(ClosingSnapshotSigningKeyService);
    approvals = moduleRef.get(ApprovalEngineService);
    appConfig = moduleRef.get(AppConfigService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('a snapshot signed under an OLD (retired) key remains verifiable after a NEW key is registered — rotation never invalidates history', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P7A'), startDate: '2033-01-01', endDate: '2033-01-31' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);

    // Step 1 — fabricate a "historical" snapshot signed under an OLD key that is NOT the service's
    // currently-configured signing key (simulating "this was signed months ago, under a key that
    // has since been rotated out").
    const oldKeyPair = generateEd25519KeyPair();
    const oldKid = `retired-${Date.now()}`;
    const keyRepo = dataSource.getRepository(ClosingSnapshotSigningKey);
    await keyRepo.save(keyRepo.create({ kid: oldKid, publicKey: oldKeyPair.publicKeyB64, validFrom: new Date(), validUntil: new Date(), createdByUserId: ADMIN_A, reason: 'test: simulated retired key' }));

    const body = { fiscalPeriodId: period.id, note: 'historical snapshot signed under a retired key' };
    const contentHash = 'sha256:' + createHash('sha256').update(canonicalizeJson(body)).digest('hex');
    const manifestCore: Omit<ClosingSnapshotManifest, 'signingKeyId' | 'signature'> = {
      manifestVersion: '1.0',
      fiscalPeriodId: period.id,
      periodCode: '2033-01',
      closeSequence: 1,
      supersedesSnapshotId: null,
      previousManifestHash: null,
      generatedAt: new Date().toISOString(),
      generatedByUserId: ADMIN_A,
      approvalRequestId: randomUUID(),
      appVersion: '1.0.10',
      migrationHead: null,
      configVersion: 'none',
      contentHash,
    };
    const signature = signEd25519(oldKeyPair.privateKeyB64, canonicalizeJson(manifestCore));
    const fullManifest: ClosingSnapshotManifest = { ...manifestCore, signingKeyId: oldKid, signature };
    const manifestHash = createHash('sha256').update(canonicalizeJson(fullManifest)).digest('hex');

    const dir = join(resolve(appConfig.mediaStoragePath), 'closing-snapshots', period.id);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${manifestHash}.json`);
    await writeFile(filePath, JSON.stringify({ manifest: fullManifest, body }));

    const runRepo = dataSource.getRepository(ClosingSnapshotRun);
    const historicalRun = await runRepo.save(
      runRepo.create({
        fiscalPeriodId: period.id,
        closeSequence: 1,
        supersedesSnapshotId: null,
        approvalRequestId: manifestCore.approvalRequestId,
        status: 'complete',
        contentHash,
        manifestHash,
        signingKeyId: oldKid,
        signature,
        manifestPath: filePath,
        generatedByUserId: ADMIN_A,
        generatedAt: new Date(),
        appVersion: manifestCore.appVersion,
        migrationHead: null,
      }),
    );

    // Sanity: verifiable BEFORE any "rotation".
    const beforeRotation = await closingSnapshots.verify(historicalRun.id);
    expect(beforeRotation).toEqual({ ok: true, contentHashMatches: true, signatureValid: true, chainValid: null });

    // Step 2 — "rotate": register a genuinely NEW key (distinct kid) and close a REAL period with
    // it, using the service's actual configured signing key (unchanged in this process, but
    // representing "the key now in use going forward" — the registry now holds two independent keys).
    await fiscalPeriods.transitionPeriod(period.id, 'soft_close', ADMIN_A);
    const request = await fiscalPeriods.submitPeriodClose(period.id, ADMIN_A);
    await approvals.decide(request.id, ADMIN_B, 'approved', 'Phase 7 — post-rotation close');
    const allRuns = await closingSnapshots.listRuns(period.id);
    const freshRun = allRuns.find((r) => r.id !== historicalRun.id)!;
    expect(freshRun.status).toBe('complete');

    // Step 3 — the CRITICAL assertion: the historical, retired-key-signed snapshot is STILL
    // verifiable, byte-for-byte unchanged, after a new key has come into use.
    const afterRotation = await closingSnapshots.verify(historicalRun.id);
    expect(afterRotation).toEqual({ ok: true, contentHashMatches: true, signatureValid: true, chainValid: null });
    const stillUnchanged = await closingSnapshots.getRun(historicalRun.id);
    expect(stillUnchanged.manifestHash).toBe(manifestHash); // untouched
    expect(stillUnchanged.signingKeyId).toBe(oldKid); // still declares the OLD kid, never rewritten

    // And the NEW snapshot verifies independently too, under its own (different) kid.
    const newVerify = await closingSnapshots.verify(freshRun.id);
    expect(newVerify.ok).toBe(true);
    expect(freshRun.signingKeyId).not.toBe(oldKid);
  }, 30_000);

  it('reports unknown_kid distinctly when a manifest declares a kid never registered', async () => {
    const year = await fiscalPeriods.createFiscalYear({ code: shortCode('P7B'), startDate: '2033-02-01', endDate: '2033-02-28' }, ADMIN_A);
    const [period] = await fiscalPeriods.listPeriods(year.id);

    const bogusKeyPair = generateEd25519KeyPair();
    const body = { note: 'unknown kid test' };
    const contentHash = 'sha256:' + createHash('sha256').update(canonicalizeJson(body)).digest('hex');
    const manifestCore = {
      manifestVersion: '1.0' as const,
      fiscalPeriodId: period.id,
      periodCode: '2033-02',
      closeSequence: 1,
      supersedesSnapshotId: null,
      previousManifestHash: null,
      generatedAt: new Date().toISOString(),
      generatedByUserId: ADMIN_A,
      approvalRequestId: randomUUID(),
      appVersion: '1.0.10',
      migrationHead: null,
      configVersion: 'none',
      contentHash,
    };
    const signature = signEd25519(bogusKeyPair.privateKeyB64, canonicalizeJson(manifestCore));
    const neverRegisteredKid = `never-registered-${Date.now()}`;
    const fullManifest = { ...manifestCore, signingKeyId: neverRegisteredKid, signature };
    const manifestHash = createHash('sha256').update(canonicalizeJson(fullManifest)).digest('hex');

    const dir = join(resolve(appConfig.mediaStoragePath), 'closing-snapshots', period.id);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${manifestHash}.json`);
    await writeFile(filePath, JSON.stringify({ manifest: fullManifest, body }));

    const runRepo = dataSource.getRepository(ClosingSnapshotRun);
    const run = await runRepo.save(
      runRepo.create({
        fiscalPeriodId: period.id,
        closeSequence: 1,
        supersedesSnapshotId: null,
        approvalRequestId: manifestCore.approvalRequestId,
        status: 'complete',
        contentHash,
        manifestHash,
        signingKeyId: neverRegisteredKid,
        signature,
        manifestPath: filePath,
        generatedByUserId: ADMIN_A,
        generatedAt: new Date(),
        appVersion: manifestCore.appVersion,
        migrationHead: null,
      }),
    );

    const result = await closingSnapshots.verify(run.id);
    expect(result.ok).toBe(false);
    expect(result.contentHashMatches).toBe(true); // content itself is fine
    expect(result.signatureValid).toBe(false); // but cannot be verified — unknown key

    const keyVerify = await signingKeys.verify(canonicalizeJson(manifestCore), signature, neverRegisteredKid);
    expect(keyVerify).toEqual({ ok: false, reason: 'unknown_kid' });
  }, 30_000);

  it('reports bad_signature distinctly when a registered key exists but the signature does not match', async () => {
    const registered = generateEd25519KeyPair();
    const kid = `test-badsig-${Date.now()}`;
    const keyRepo = dataSource.getRepository(ClosingSnapshotSigningKey);
    await keyRepo.save(keyRepo.create({ kid, publicKey: registered.publicKeyB64, validFrom: new Date(), validUntil: null, createdByUserId: ADMIN_A, reason: 'test: bad signature' }));

    const wrongSignerKeyPair = generateEd25519KeyPair(); // signs with a DIFFERENT key than the one registered under `kid`
    const forgedSignature = signEd25519(wrongSignerKeyPair.privateKeyB64, canonicalizeJson({ some: 'payload' }));

    const result = await signingKeys.verify(canonicalizeJson({ some: 'payload' }), forgedSignature, kid);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
