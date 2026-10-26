import { MigrationInterface, QueryRunner } from 'typeorm';

// <terminology-ownership:begin> (identical in every seed migration; guarded by terminology-ownership.spec.ts - migrations must stay self-contained)
type TerminologyRow = readonly [code: string, category: string, ar: string, en: string];
type TerminologySeedMode = 'preserve' | 'update';

const TABLE = 'terminology_seed_ownership';

async function ensureTable(q: QueryRunner): Promise<void> {
  await q.query(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" ("code" VARCHAR(128) PRIMARY KEY, "owner" VARCHAR(64) NOT NULL, "migration" VARCHAR(160) NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
}

async function seedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[], mode: TerminologySeedMode): Promise<void> {
  await ensureTable(q);
  for (const [code, category, ar, en] of rows) {
    const inserted: Array<{ code: string }> = await q.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING RETURNING "code"`,
      [code, category, ar, en],
    );
    if (inserted.length > 0) {
      await q.query(`INSERT INTO "${TABLE}" ("code", "owner", "migration") VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [code, owner, migration]);
      continue;
    }
    if (mode === 'update') {
      await q.query(
        `UPDATE "terminology_entries" SET "ar" = $2, "en" = $3 WHERE "code" = $1 AND EXISTS (SELECT 1 FROM "${TABLE}" o WHERE o."code" = $1 AND o."owner" = $4)`,
        [code, ar, en, owner],
      );
    }
  }
}

async function unseedTerminologyOwned(q: QueryRunner, owner: string, migration: string, rows: readonly TerminologyRow[]): Promise<void> {
  await ensureTable(q);
  const codes = rows.map(([code]) => code);
  await q.query(
    `DELETE FROM "terminology_entries" WHERE "code" IN (SELECT "code" FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1))`,
    [codes, owner, migration],
  );
  await q.query(`DELETE FROM "${TABLE}" WHERE "owner" = $2 AND "migration" = $3 AND "code" = ANY($1)`, [codes, owner, migration]);
}
// <terminology-ownership:end>


/**
 * Payroll gap closure (2026-10-25) — Arabic / English labels for the new Run Detail panels (exceptions, inputs, actors, payouts, reconciliation), the revision /
 * kind / superseded states and the compensation, period and commission-policy changes. Only NEW codes; existing codes are never overwritten (`DO NOTHING`).
 */
export class SeedPayrollGapClosureTerminology1790100100000 implements MigrationInterface {
  name = 'SeedPayrollGapClosureTerminology1790100100000';

  private readonly rows: Array<[string, string, string]> = [
    ['action.acknowledge_exceptions', 'تأكيد الاستثناءات المحددة', 'Acknowledge selected exceptions'],
    ['action.calculate_supplementary', 'احتساب دورة مكمِّلة', 'Calculate supplementary run'],
    ['action.cancel_payout_batch', 'إلغاء دفعة الصرف', 'Cancel payout batch'],
    ['action.close_period', 'إقفال الفترة', 'Close period'],
    ['action.create_payout_batch', 'إنشاء دفعة صرف', 'Create payout batch'],
    ['action.execute_payout_batch', 'تنفيذ دفعة الصرف', 'Execute payout batch'],
    ['action.recalculate_run', 'إعادة الاحتساب', 'Recalculate'],
    ['nav.payroll_settings', 'إعدادات الرواتب', 'Payroll Settings'],
    ['field.sod_profile', 'ملف فصل المهام', 'Segregation-of-duties profile'],
    ['panel.sod_profile_hint', 'الحد الأدنى الإلزامي ثابت في كل الملفات: لا يعتمد الدورة من أعدّها أو قدّمها للاعتماد.', 'The mandatory floor applies in every profile: the approver is neither the preparer nor the submitter of the run.'],
    ['panel.sod_profile_standard', 'الحد الأدنى + من يؤكد الاستثناء ليس من أعدّ الدورة + من يصرف ليس من اعتمد.', 'Floor + the person acknowledging an exception did not prepare the run + the person disbursing did not approve it.'],
    ['panel.sod_profile_strict', 'القياسي + المُعِدّ والمراجِع والمُقدِّم والمعتمِد ومؤكِّد الاستثناء أشخاص مختلفون + من يطابق ليس من صرف.', 'Standard + preparer, reviewer, submitter, approver and exception acknowledger are all different people + the reconciler did not disburse.'],
    ['value.sod_profile.standard', 'قياسي', 'Standard'],
    ['value.sod_profile.strict', 'صارم', 'Strict'],
    ['msg.settings_saved', 'تم حفظ الإعداد.', 'Setting saved.'],
    ['value.compensation_status.active', 'ساري', 'Active'],
    ['value.compensation_status.superseded', 'مُستبدَل', 'Superseded'],
    ['error.payroll_date_format', 'يجب أن يكون التاريخ بصيغة سنة-شهر-يوم.', 'The date must be in YYYY-MM-DD format.'],
    ['error.payroll_period_date_order', 'تاريخ البداية يجب ألا يتجاوز تاريخ النهاية.', 'The start date must not be after the end date.'],
    ['error.payroll_period_overlap', 'الفترة تتداخل مع فترة الرواتب «{code}».', 'The period overlaps payroll period "{code}".'],
    ['error.payroll_period_overlap_generic', 'الفترة تتداخل مع فترة رواتب قائمة.', 'The period overlaps an existing payroll period.'],
    ['error.payroll_period_code_exists', 'توجد فترة رواتب بالكود «{code}» مسبقًا.', 'A payroll period with code "{code}" already exists.'],
    ['error.payroll_period_not_found', 'فترة الرواتب غير موجودة.', 'The payroll period was not found.'],
    ['error.payroll_period_already_closed', 'فترة الرواتب «{code}» مقفلة مسبقًا.', 'Payroll period "{code}" is already closed.'],
    ['error.payroll_period_close_no_posted_regular', 'لا يمكن إقفال الفترة «{code}»: دورتها الأساسية غير مرحّلة.', 'Period "{code}" cannot be closed: its regular run is not posted.'],
    ['error.payroll_period_close_open_supplementary', 'لا يمكن إقفال الفترة «{code}»: الدورة المكمِّلة «{run}» لم تكتمل بعد.', 'Period "{code}" cannot be closed: supplementary run "{run}" is not finished.'],
    ['error.payroll_comp_reason_required', 'سبب التغيير مطلوب لكل تعديل في الأجر.', 'A reason is required for every compensation change.'],
    ['error.payroll_comp_earning_required', 'يجب إدخال بند أجر واحد على الأقل.', 'At least one earning line is required.'],
    ['error.payroll_comp_component_code', 'كود مكوّن الأجر مطلوب (من 1 إلى 32 حرفًا).', 'Each earning line needs a component code (1-32 characters).'],
    ['error.payroll_comp_component_duplicate', 'مكوّن الأجر «{code}» مكرر.', 'Earning component "{code}" appears more than once.'],
    ['error.payroll_comp_amount_positive', 'مبلغ البند «{code}» يجب أن يكون رقمًا موجبًا.', 'The amount of line "{code}" must be a positive number.'],
    ['error.payroll_comp_amount_decimals', 'مبلغ البند «{code}» يزيد عن خانتين عشريتين.', 'The amount of line "{code}" has more than two decimal places.'],
    ['error.payroll_comp_not_after_current', 'يجب أن يبدأ الأجر الجديد بعد بداية الأجر الحالي ({since})؛ السجل التاريخي لا يُعاد كتابته.', 'The new compensation must start after the current one ({since}); history is never rewritten.'],
    ['error.payroll_period_closed_use_supplementary', 'الفترة «{code}» مقفلة — استخدم دورة مكمِّلة للتصحيح بعد الإقفال.', 'Period "{code}" is closed — use a supplementary run for a post-close correction.'],
    ['error.payroll_period_has_posted_run', 'للفترة «{code}» دورة مرحّلة — إعادة الاحتساب تتم بدورة مكمِّلة.', 'Period "{code}" already has a posted run — recalculation needs a supplementary run.'],
    ['error.payroll_no_posted_regular', 'لا توجد دورة أساسية مرحّلة للفترة «{code}» — الدورة المكمِّلة تصحح فترة مرحّلة فقط.', 'Period "{code}" has no posted regular run — a supplementary run corrects a posted period only.'],
    ['error.payroll_run_not_found', 'دورة الرواتب غير موجودة.', 'The payroll run was not found.'],
    ['error.payroll_run_not_reviewed', 'يجب أن تكون الدورة «تمت المراجعة» قبل التقديم للاعتماد.', 'The run must be reviewed before it is submitted for approval.'],
    ['error.payroll_sod_profile_invalid', 'ملف فصل المهام يجب أن يكون «قياسي» أو «صارم».', 'The segregation-of-duties profile must be "standard" or "strict".'],
    ['error.payroll_line_not_found', 'بند الدورة غير موجود.', 'The run line was not found.'],
    ['error.payroll_adj_run_not_posted', 'التسوية تصحح دورة مرحّلة؛ الدورة «{code}» غير مرحّلة — أعد احتسابها بدلًا من ذلك.', 'An adjustment corrects a posted run; run "{code}" is not posted — recalculate it instead.'],
    ['error.payroll_adj_amount_nonzero', 'مبلغ التسوية يجب أن يكون رقمًا غير صفري.', 'The adjustment amount must be a non-zero number.'],
    ['error.payroll_adj_amount_decimals', 'مبلغ التسوية يزيد عن خانتين عشريتين.', 'The adjustment amount has more than two decimal places.'],
    ['error.payroll_adj_reason_required', 'سبب التسوية مطلوب.', 'An adjustment needs a reason.'],
    ['error.payroll_exceptions_open', 'في الدورة {count} استثناء/استثناءات غير محسومة. عالج السبب وأعد الاحتساب، أو أكّد الاستثناءات الموثقة.', 'The run has {count} unresolved exception(s). Fix the cause and recalculate, or acknowledge the documented ones.'],
    ['error.payroll_totals_mismatch', 'إجماليات الدورة المخزنة لم تعد مساوية لمجموع بنودها — أعد احتساب الدورة.', 'The stored run totals no longer equal the sum of its lines — recalculate the run.'],
    ['error.payroll_inputs_changed', 'تغيّرت المعطيات التي بُنيت عليها الدورة بعد احتسابها — أعد الاحتساب.', 'The facts this run was calculated from changed after the calculation — recalculate the run.'],
    ['error.payroll_payout_run_not_posted', 'لا يُصرف إلا من دورة مرحّلة.', 'Only a posted run can be paid out.'],
    ['error.payroll_payout_item_not_found', 'بند الصرف غير موجود.', 'The payout item was not found.'],
    ['error.payroll_payout_batch_not_found', 'دفعة الصرف غير موجودة.', 'The payout batch was not found.'],
    ['error.payroll_payout_batch_cancelled', 'دفعة الصرف «{code}» ملغاة.', 'Payout batch "{code}" is cancelled.'],
    ['error.payroll_payout_batch_no_pending', 'دفعة الصرف «{code}» لا تحتوي بنودًا معلّقة.', 'Payout batch "{code}" has no pending items.'],
    ['error.payroll_payout_batch_not_draft', 'لا يُلغى إلا الدفعة في حالة المسودة.', 'Only a draft batch can be cancelled.'],
    ['error.payroll_payout_event_not_posted', 'لا يمكن الصرف: قيد الدورة المالي لم يُرحَّل بعد.', 'Cannot pay out: the run\'s ledger entry has not been posted yet.'],
    ['error.payroll_payout_already_disbursed', 'تم صرف هذه الدورة بالكامل مسبقًا.', 'This run has already been fully disbursed.'],
    ['error.payroll_payout_nothing_outstanding', 'لا يوجد متبقٍ للصرف — الدفعات المعلّقة تغطي كل البنود.', 'Nothing is outstanding — pending payouts already cover every line.'],
    ['error.payroll_payout_account_unmapped', 'حساب الخزينة غير مربوط بحساب في دليل الحسابات — اربطه قبل الصرف.', 'The treasury account is not mapped to a chart account — map it before paying out.'],
    ['error.payroll_decision_ref_required', 'مرجع القرار الموثق مطلوب (3 أحرف على الأقل) لتأكيد الاستثناء.', 'A decision reference (at least 3 characters) is required to acknowledge an exception.'],
    ['error.payroll_exc_run_state', 'تُؤكَّد الاستثناءات فقط والدورة «محتسبة» أو «تمت المراجعة».', 'Exceptions can be acknowledged only while the run is calculated or reviewed.'],
    ['error.payroll_exc_selection_required', 'حدّد استثناءً واحدًا على الأقل للتأكيد.', 'Select at least one exception to acknowledge.'],
    ['error.payroll_exc_none_open', 'لا يوجد استثناء مفتوح مطابق في هذه الدورة.', 'No matching open exception on this run.'],
    ['error.payroll_exc_not_acknowledgeable', 'هذا الاستثناء يمنع الاعتماد ولا يُؤكَّد — عالج السبب وأعد الاحتساب.', 'This exception blocks approval and cannot be acknowledged — fix the cause and recalculate.'],
    ['error.validation_error', 'البيانات المُدخلة غير صالحة — راجع الحقول وأعد المحاولة.', 'The data entered is not valid — check the fields and try again.'],
    ['error.forbidden', 'ليست لديك صلاحية لتنفيذ هذه العملية.', 'You do not have permission to perform this action.'],
    ['error.payout_insufficient_balance', 'رصيد حساب الخزينة غير كافٍ: المطلوب {requested}، المتاح {available}، العجز {short}.', 'Insufficient treasury balance: requested {requested}, available {available}, short by {short}.'],
    ['error.not_found', 'غير متاح — إما أنه غير موجود أو لا تملك صلاحية عرضه.', 'Not available — it does not exist or you do not have permission to view it.'],
    ['error.sod_violation', 'فصل المهام: لا يجوز لمن نفّذ مرحلة سابقة من هذه الدورة تنفيذ هذه المرحلة.', 'Segregation of duties: the person who performed an earlier stage of this run cannot perform this stage.'],
    ['field.commission_result', 'نتيجة العمولة', 'Commission result'],
    ['field.adjustments_amount', 'التسويات', 'Adjustments'],
    ['field.at', 'التوقيت', 'At'],
    ['field.attendance_status', 'حالة الحضور', 'Attendance status'],
    ['field.carried_forward', 'مُرحَّل من فترة سابقة', 'Carried forward'],
    ['field.decision_reference', 'مرجع القرار الموثق', 'Decision reference'],
    ['field.effective_from', 'ساري من', 'Effective from'],
    ['field.effective_to', 'ساري حتى', 'Effective to'],
    ['field.exception_class', 'تصنيف الاستثناء', 'Exception class'],
    ['field.exception_code', 'الاستثناء', 'Exception'],
    ['field.failed', 'فشل', 'Failed'],
    ['field.failure_reason', 'سبب الفشل', 'Failure reason'],
    ['field.input_kind', 'نوع المدخل', 'Input kind'],
    ['field.ledger_payable', 'رواتب مستحقة (دائن − مدين)', 'Wages payable (credit − debit)'],
    ['field.outstanding', 'المتبقي للصرف', 'Outstanding'],
    ['field.paid', 'المصروف', 'Paid'],
    ['field.payout_batch', 'دفعة الصرف', 'Payout batch'],
    ['field.payroll_period', 'فترة الرواتب', 'Payroll period'],
    ['field.pending', 'معلّق', 'Pending'],
    ['field.performed_by', 'المنفِّذ', 'Performed by'],
    ['field.revision', 'المراجعة', 'Revision'],
    ['field.run_kind', 'نوع الدورة', 'Run kind'],
    ['field.stage', 'المرحلة', 'Stage'],
    ['field.total_expense', 'المصروف (الدورة / القيد)', 'Expense (run / ledger)'],
    ['field.treasury_cash_out', 'خروج نقدي من الخزينة', 'Treasury cash out'],
    ['msg.action_failed', 'تعذّر تنفيذ العملية.', 'The action could not be completed.'],
    ['msg.consistent', 'متطابق', 'Consistent'],
    ['msg.inconsistent', 'توجد فروق', 'Differences found'],
    ['msg.load_failed', 'تعذّر تحميل البيانات.', 'Could not load the data.'],
    ['msg.loading', 'جارٍ التحميل…', 'Loading…'],
    ['panel.commission_disabled_kinds_notice', 'أساس «صافي المبيعات» ونطاق «مجموعة العملاء» معطّلان إلى حين اعتماد تعريفهما ومصدر بياناتهما.', 'The "net sales" basis and the "customer group" scope are disabled until their definition and data source are approved.'],
    ['panel.payroll_actors', 'من نفّذ كل مرحلة', 'Who performed each stage'],
    ['panel.payroll_exceptions', 'استثناءات الدورة', 'Run exceptions'],
    ['panel.payroll_exceptions_hint', 'كل حالة تغيّر من يُصرف له أو على أي أساس تظهر هنا ولا تُتجاهل بصمت. الاستثناءات من فئة «يتطلب توثيقاً» تُؤكَّد بمرجع قرار؛ الفئة «يمنع الاعتماد» تُعالج من المصدر ثم تُعاد الدورة.', 'Every condition that changes who is paid, or on what basis, is listed here and never skipped silently. "Needs documentation" items are acknowledged with a decision reference; "blocks approval" items are fixed at the source and the run is recalculated.'],
    ['panel.payroll_inputs', 'عمولات وتسويات محجوزة لهذه الدورة', 'Commission and adjustments held by this run'],
    ['panel.payroll_no_exceptions', 'لا توجد استثناءات', 'No exceptions'],
    ['panel.payroll_no_inputs', 'لا توجد عمولات أو تسويات في هذه الدورة', 'No commission or adjustments in this run'],
    ['panel.payroll_no_payouts', 'لا توجد دفعات صرف بعد', 'No payout batches yet'],
    ['panel.payroll_payouts', 'دفعات الصرف', 'Payouts'],
    ['panel.payroll_payouts_hint', 'الدفعة الفاشلة تبقى في السجل ولا تُرحَّل؛ المتبقي يُعاد إصداره كبند جديد.', 'A failed payment stays in the history and posts nothing; the remainder is re-issued as a new item.'],
    ['panel.payroll_reconciliation', 'مطابقة الدورة', 'Run reconciliation'],
    ['panel.payroll_rejection_notice', 'أُعيدت الدورة بعد الرفض', 'The run was returned after a rejection'],
    ['panel.payroll_superseded_notice', 'حلّت محلها مراجعة أحدث من هذه الدورة؛ تبقى للسجل فقط.', 'A newer revision replaced this run; it is kept for history only.'],
    ['panel.reconciliation_gap', 'فجوة مطابقة: الدورة مرحَّلة ولم يُؤكَّد قيدها', 'Reconciliation gap: the run is posted but its ledger entry is not confirmed'],
    ['value.exception_class.A_DOC', 'يتطلب توثيقاً', 'Needs documentation'],
    ['value.exception_class.B_APPROVE', 'يمنع الاعتماد', 'Blocks approval'],
    ['value.exception_class.INFO', 'معلومة', 'Information'],
    ['value.exception_status.acknowledged', 'مؤكَّد', 'Acknowledged'],
    ['value.exception_status.open', 'مفتوح', 'Open'],
    ['value.exception_status.resolved', 'مُعالَج', 'Resolved'],
    ['value.input_kind.commission_adjustment', 'تسوية عمولة', 'Commission adjustment'],
    ['value.input_kind.commission_result', 'عمولة معتمدة', 'Approved commission'],
    ['value.input_kind.payroll_adjustment', 'تسوية رواتب', 'Payroll adjustment'],
    ['value.input_state.consumed', 'مستهلك', 'Consumed'],
    ['value.input_state.released', 'مُحرَّر', 'Released'],
    ['value.input_state.reserved', 'محجوز', 'Reserved'],
    ['value.payout_batch_status.cancelled', 'ملغاة', 'Cancelled'],
    ['value.payout_batch_status.completed', 'مكتملة', 'Completed'],
    ['value.payout_batch_status.draft', 'مسودة', 'Draft'],
    ['value.payout_batch_status.executing', 'قيد التنفيذ', 'Executing'],
    ['value.payout_batch_status.failed', 'فشلت', 'Failed'],
    ['value.payout_batch_status.partially_completed', 'مكتملة جزئياً', 'Partially completed'],
    ['value.payout_status.failed', 'فشل', 'Failed'],
    ['value.payout_status.paid', 'مصروف', 'Paid'],
    ['value.payout_status.pending', 'معلّق', 'Pending'],
    ['value.payroll_exception.ADJUSTMENTS_APPLIED', 'تسويات مُطبَّقة في الدورة', 'Adjustments applied in this run'],
    ['value.payroll_exception.COMMISSION_CARRIED_FORWARD', 'عمولة مُرحَّلة من فترة سابقة', 'Commission carried forward from an earlier period'],
    ['value.payroll_exception.COMPENSATION_CHANGE_IN_PERIOD', 'تغيّر الأجر داخل الفترة (لا يوجد توزيع نسبي)', 'Compensation changes inside the period (no proration rule)'],
    ['value.payroll_exception.EMPLOYEE_ON_LEAVE_STATUS', 'الموظف بحالة «إجازة» ولم يُحتسب', 'Employee on leave status — not calculated'],
    ['value.payroll_exception.EMPTY_RUN', 'دورة بلا بنود', 'Run has no lines'],
    ['value.payroll_exception.EXPENSE_ACCOUNT_MISSING', 'حساب مصروف الرواتب غير متاح للترحيل', 'Payroll expense account is not available for posting'],
    ['value.payroll_exception.INPUT_TAKEN_BY_ANOTHER_RUN', 'مدخل محجوز لدورة أخرى', 'Input already held by another run'],
    ['value.payroll_exception.NEGATIVE_NET_PAY', 'صافي الأجر سالب', 'Net pay is negative'],
    ['value.payroll_exception.NO_ATTENDANCE_COVERAGE', 'لا يوجد حضور معتمد للفترة', 'No approved attendance for the period'],
    ['value.payroll_exception.NO_COMPENSATION', 'لا يوجد أجر ساري — لم يُحتسب', 'No effective compensation — not calculated'],
    ['value.payroll_exception.TERMINATED_IN_PERIOD', 'انتهت خدمته خلال الفترة — لم يُحتسب', 'Service ended in the period — not calculated'],
    ['value.payroll_exception.UNCLASSIFIED_ABSENCE_DAYS', 'أيام غياب غير مصنّفة (لا خصم)', 'Unclassified absence days (no deduction)'],
    ['value.payroll_exception.WAGES_PAYABLE_ACCOUNT_MISSING', 'حساب الرواتب المستحقة غير متاح للترحيل', 'Wages payable account is not available for posting'],
    ['value.payroll_run_kind.regular', 'أساسية', 'Regular'],
    ['value.payroll_run_kind.supplementary', 'مكمِّلة', 'Supplementary'],
    ['value.payroll_run_status.superseded', 'حلّت محلها مراجعة أحدث', 'Superseded'],
    ['value.stage.acknowledge_exception', 'تأكيد استثناء', 'Exception acknowledged'],
    ['value.stage.approve', 'اعتماد', 'Approval'],
    ['value.stage.close_period', 'إقفال الفترة', 'Period closed'],
    ['value.stage.disburse', 'صرف', 'Disbursement'],
    ['value.stage.prepare', 'احتساب', 'Calculation'],
    ['value.stage.reconcile', 'مطابقة', 'Reconciliation'],
    ['value.stage.review', 'مراجعة', 'Review'],
    ['value.stage.submit', 'تقديم للاعتماد', 'Submission'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'payroll', this.name, this.rows.map(([code, ar, en]) => [code, code.startsWith('action.') ? 'action' : code.startsWith('panel.') ? 'panel' : 'field', ar, en] as const), 'preserve');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'payroll', this.name, this.rows.map(([code, ar, en]) => [code, '', ar, en] as const));
  }
}
