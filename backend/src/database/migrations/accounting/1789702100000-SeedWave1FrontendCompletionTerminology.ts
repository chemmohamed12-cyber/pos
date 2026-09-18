import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). ADR-058 (Wave 1 Frontend Completion) —
 * GRNI Reconciliation, Closing Audit, Closing Exceptions, and Closing
 * Snapshot (Immutable Black Box) screens. Labels already seeded for the
 * AP/AR/Cash-Bank/Inventory reconciliation pattern (`field.as_of_date`,
 * `field.subledger_total`, `field.gl_balance`, `field.drift`,
 * `field.reconciliation_status`, `value.reconciliation_status.*`,
 * `action.run_reconciliation`, `action.close_reconciliation`) are reused
 * as-is by the new GRNI page, not re-seeded here. Same idempotent
 * (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedWave1FrontendCompletionTerminology1789702100000 implements MigrationInterface {
  name = 'SeedWave1FrontendCompletionTerminology1789702100000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.grni_reconciliation', 'field', 'تسوية حساب البضاعة المستلمة غير المفوترة', 'GRNI Reconciliation'],
    ['nav.closing_audit', 'field', 'تدقيق الإغلاق', 'Closing Audit'],
    ['nav.closing_exceptions', 'field', 'استثناءات الإغلاق', 'Closing Exceptions'],
    ['nav.closing_snapshots', 'field', 'لقطات الإغلاق المعتمدة', 'Closing Snapshots'],

    ['field.purchase_order', 'field', 'أمر الشراء', 'Purchase Order'],
    ['action.view_grni_detail', 'field', 'عرض تفاصيل الانحراف', 'View Detail'],
    ['panel.no_grni_reconciliations_yet', 'panel', 'لا توجد تسويات GRNI بعد', 'No GRNI reconciliations yet'],
    ['panel.grni_drift_detail', 'panel', 'تفاصيل انحراف GRNI', 'GRNI Drift Detail'],

    ['field.closing_audit_status', 'field', 'حالة تدقيق الإغلاق', 'Closing Audit Status'],
    ['field.closing_workflow_entry_state', 'field', 'حالة الدخول لمسار الإغلاق', 'Workflow Entry State'],
    ['field.closing_workflow_status', 'field', 'حالة مسار الإغلاق', 'Workflow Status'],
    ['field.completed_at', 'field', 'تاريخ الاكتمال', 'Completed At'],
    ['value.closing_audit_status.clean', 'field', 'نظيف', 'Clean'],
    ['value.closing_audit_status.exceptions_found', 'field', 'تم العثور على استثناءات', 'Exceptions Found'],
    ['value.closing_workflow_entry_state.soft_close', 'field', 'إغلاق مبدئي', 'Soft Close'],
    ['value.closing_workflow_entry_state.reopened', 'field', 'أُعيد فتحها', 'Reopened'],
    ['value.closing_workflow_status.audit_run', 'field', 'تم تشغيل التدقيق', 'Audit Run'],
    ['value.closing_workflow_status.exceptions_open', 'field', 'استثناءات مفتوحة', 'Exceptions Open'],
    ['value.closing_workflow_status.final_reconciliation_passed', 'field', 'اجتازت التسوية النهائية', 'Final Reconciliation Passed'],
    ['value.closing_workflow_status.approval_submitted', 'field', 'تم تقديم طلب الموافقة', 'Approval Submitted'],
    ['value.closing_workflow_status.approved', 'field', 'تمت الموافقة', 'Approved'],
    ['value.closing_workflow_status.period_locked', 'field', 'تم قفل الفترة', 'Period Locked'],
    ['value.closing_workflow_status.failed', 'field', 'فشل', 'Failed'],
    ['action.run_closing_audit', 'field', 'تشغيل تدقيق الإغلاق', 'Run Closing Audit'],
    ['panel.no_closing_audit_runs_yet', 'panel', 'لا توجد عمليات تدقيق إغلاق بعد', 'No closing audit runs yet'],
    ['panel.no_closing_workflow_runs_yet', 'panel', 'لا توجد محاولات إغلاق بعد', 'No closing workflow runs yet'],

    ['field.module', 'field', 'الوحدة', 'Module'],
    ['field.category', 'field', 'الفئة', 'Category'],
    ['field.severity', 'field', 'الخطورة', 'Severity'],
    ['field.problem', 'field', 'المشكلة', 'Problem'],
    ['field.required_action', 'field', 'الإجراء المطلوب', 'Required Action'],
    ['field.transaction_ref', 'field', 'مرجع المعاملة', 'Transaction Ref'],
    ['field.account_or_subledger_ref', 'field', 'مرجع الحساب/دفتر الأستاذ الفرعي', 'Account/Subledger Ref'],
    ['field.annotation', 'field', 'ملاحظة التصنيف', 'Annotation'],
    ['value.closing_exception_severity.blocking', 'field', 'معيق', 'Blocking'],
    ['value.closing_exception_severity.informational', 'field', 'إعلامي', 'Informational'],
    ['value.closing_exception_status.open', 'field', 'مفتوح', 'Open'],
    ['value.closing_exception_status.acknowledged', 'field', 'تم الإقرار به', 'Acknowledged'],
    ['value.closing_exception_status.resolved', 'field', 'تمت التسوية', 'Resolved'],
    ['value.closing_exception_status.waived', 'field', 'تم التنازل عنه', 'Waived'],
    ['value.closing_exception_category.LIVE_DISCREPANCY', 'field', 'انحراف فعلي حي', 'Live Discrepancy'],
    ['value.closing_exception_category.DORMANT_SOURCE', 'field', 'مصدر غير نشط', 'Dormant Source'],
    ['value.closing_exception_category.EXPECTED_BUSINESS_REJECTION', 'field', 'رفض تجاري متوقع', 'Expected Business Rejection'],
    ['value.closing_exception_category.CONFIGURATION_EXCEPTION', 'field', 'استثناء إعداد', 'Configuration Exception'],
    ['value.closing_exception_category.HISTORICAL_TEST_ARTIFACT', 'field', 'أثر اختبار تاريخي', 'Historical Test Artifact'],
    ['value.closing_exception_category.UNCLASSIFIED_REJECTION', 'field', 'رفض غير مصنف', 'Unclassified Rejection'],
    ['action.acknowledge', 'field', 'إقرار', 'Acknowledge'],
    ['action.annotate_test_artifact', 'field', 'تصنيف كأثر اختبار تاريخي', 'Annotate as Test Artifact'],
    ['panel.no_closing_exceptions', 'panel', 'لا توجد استثناءات إغلاق', 'No closing exceptions'],

    ['field.close_sequence', 'field', 'تسلسل الإغلاق', 'Close Sequence'],
    ['field.supersedes_snapshot', 'field', 'يحل محل اللقطة', 'Supersedes Snapshot'],
    ['field.snapshot_status', 'field', 'حالة اللقطة', 'Snapshot Status'],
    ['field.content_hash', 'field', 'بصمة المحتوى', 'Content Hash'],
    ['field.manifest_hash', 'field', 'بصمة البيان', 'Manifest Hash'],
    ['field.signing_key_id', 'field', 'معرّف مفتاح التوقيع', 'Signing Key ID'],
    ['field.generated_at', 'field', 'تاريخ الإنشاء', 'Generated At'],
    ['value.snapshot_status.pending', 'field', 'قيد الإنشاء', 'Pending'],
    ['value.snapshot_status.complete', 'field', 'مكتملة', 'Complete'],
    ['value.snapshot_status.failed', 'field', 'فشلت', 'Failed'],
    ['action.verify_snapshot', 'field', 'التحقق من اللقطة', 'Verify Snapshot'],
    ['panel.no_closing_snapshots_yet', 'panel', 'لا توجد لقطات إغلاق بعد', 'No closing snapshots yet'],
    ['panel.snapshot_verify_result', 'panel', 'نتيجة التحقق', 'Verify Result'],
    ['panel.snapshot_content_hash_matches', 'panel', 'تطابق بصمة المحتوى', 'Content Hash Matches'],
    ['panel.snapshot_signature_valid', 'panel', 'صحة التوقيع', 'Signature Valid'],
    ['panel.snapshot_chain_valid', 'panel', 'صحة سلسلة الإغلاقات', 'Chain Valid'],
    ['panel.snapshot_chain_no_predecessor', 'panel', 'لا توجد لقطة سابقة للتحقق منها', 'No predecessor to check'],

    ['panel.blocking_exceptions_exist', 'panel', 'يوجد استثناءات معيقة غير محلولة لهذه الفترة', 'Blocking exceptions exist for this period'],
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
