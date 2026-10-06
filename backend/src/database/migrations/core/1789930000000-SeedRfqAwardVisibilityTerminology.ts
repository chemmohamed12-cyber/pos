import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D6 (2026-10-05) — RFQ award visibility: the award's "Pending Approval" panel on the RFQ screen and the clearer Approvals
 * queue (who submitted, which node/approver count applies, open the resource). Same idempotent seed shape as every other
 * terminology migration. The maker-checker rule itself is unchanged.
 */
export class SeedRfqAwardVisibilityTerminology1789930000000 implements MigrationInterface {
  name = 'SeedRfqAwardVisibilityTerminology1789930000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.award_pending_approval', 'panel', 'الترسية بانتظار الاعتماد', 'Award pending approval'],
    ['panel.award_pending_hint', 'panel', 'يلزم مستخدم آخر (غير مقدّم الطلب) يملك الصلاحية للاعتماد', 'A different user (not the submitter) holding the required node must approve'],
    ['panel.award_submitted_by_you', 'panel', 'قدّمتَ هذا الطلب', 'You submitted this request'],
    ['panel.award_approved_po', 'panel', 'تم اعتماد الترسية — أمر الشراء', 'Award approved — Purchase Order'],
    ['panel.award_rejected_hint', 'panel', 'لم تُعتمد الترسية؛ يمكن إعادة الترسية', 'The award was not approved; it can be awarded again'],
    ['panel.award_submitted_notice', 'panel', 'تم إرسال الترسية للاعتماد — رقم الطلب', 'Award submitted for approval — request id'],
    ['field.approval_request_id', 'field', 'رقم طلب الاعتماد', 'Approval request'],
    ['field.submitted_by', 'field', 'مقدّم الطلب', 'Submitted by'],
    ['field.you', 'field', 'أنت', 'You'],
    ['panel.maker_cannot_decide', 'panel', 'لا يمكنك اعتماد طلبك — يلزم مستخدم آخر', 'You cannot approve your own request — a different approver is required'],
    ['action.open_approvals', 'action', 'فتح الاعتمادات', 'Open approvals'],
    ['action.open_resource', 'action', 'فتح المستند', 'Open document'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
