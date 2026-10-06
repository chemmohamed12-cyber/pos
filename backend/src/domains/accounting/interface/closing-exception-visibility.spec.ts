import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { AccountingController } from './accounting.controller';
import { ClosingException } from '../infrastructure/closing-exception.entity';
import { AuthService } from '../../../foundation/authentication/auth.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';

/**
 * ADR-058 (Wave 1 Frontend Completion, CTO decision 2). Proves
 * `AccountingController.listClosingExceptions`'s new visibility filter: a
 * `HISTORICAL_TEST_ARTIFACT` row is hidden from a caller who lacks
 * `accounting.closing_exception.annotate_test_artifact` at `editable`
 * (here, a fresh user holding only the read-only `accounting.viewer`
 * role), and shown to one who holds it (`admin`, via its existing blanket
 * `accounting: editable` grant) — while every other category is visible to
 * both. The exception's own `category` in the database is never touched by
 * this filter (asserted directly against the repository).
 */
describe('AccountingController.listClosingExceptions — HISTORICAL_TEST_ARTIFACT visibility (ADR-058)', () => {
  let moduleRef: TestingModule;
  let controller: AccountingController;
  let dataSource: DataSource;
  let auth: AuthService;
  let authorization: AuthorizationService;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    controller = moduleRef.get(AccountingController);
    dataSource = moduleRef.get(DataSource);
    auth = moduleRef.get(AuthService);
    authorization = moduleRef.get(AuthorizationService);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  function fakeReq(userId: string) {
    // Area 21: the handler reads the Company context. This suite runs on the disposable seeded database, so its "Company" connection is that same database.
    return { user: { id: userId }, companyContext: { companyId: 'visibility-spec', dataSource } } as never;
  }

  it('hides HISTORICAL_TEST_ARTIFACT from a viewer without annotate_test_artifact, shows it to admin, and never mutates the category', async () => {
    const fiscalPeriodId = randomUUID();
    const closingAuditRunId = randomUUID();
    const repo = dataSource.getRepository(ClosingException);

    const testArtifactRow = await repo.save(
      repo.create({
        closingAuditRunId,
        fiscalPeriodId,
        module: 'financial_events',
        source: 'financial_event',
        category: 'HISTORICAL_TEST_ARTIFACT',
        severity: 'informational',
        problem: 'Test fixture — historical test artifact.',
        requiredAction: 'None.',
        status: 'acknowledged',
        annotation: { byUserId: ADMIN_A, at: new Date().toISOString(), reason: 'ADR-058 visibility spec fixture' },
      }),
    );
    const liveRow = await repo.save(
      repo.create({
        closingAuditRunId,
        fiscalPeriodId,
        module: 'ar',
        source: 'ar_reconciliation',
        category: 'LIVE_DISCREPANCY',
        severity: 'blocking',
        problem: 'Test fixture — live discrepancy.',
        requiredAction: 'Investigate.',
        status: 'open',
      }),
    );

    const viewerEmail = `adr058-viewer-${Date.now()}@daii.example`;
    const viewer = await auth.register(viewerEmail, 'ADR-058 Viewer Fixture', 'TestPassword123!');
    await authorization.assignRole(viewer.id, 'accounting.viewer');

    const asViewer = await controller.listClosingExceptions(fiscalPeriodId, fakeReq(viewer.id));
    expect(asViewer.map((e) => e.id)).toContain(liveRow.id);
    expect(asViewer.map((e) => e.id)).not.toContain(testArtifactRow.id);

    const asAdmin = await controller.listClosingExceptions(fiscalPeriodId, fakeReq(ADMIN_A));
    expect(asAdmin.map((e) => e.id)).toContain(liveRow.id);
    expect(asAdmin.map((e) => e.id)).toContain(testArtifactRow.id);

    const reloaded = await repo.findOne({ where: { id: testArtifactRow.id } });
    expect(reloaded?.category).toBe('HISTORICAL_TEST_ARTIFACT');
  }, 30_000);
});
