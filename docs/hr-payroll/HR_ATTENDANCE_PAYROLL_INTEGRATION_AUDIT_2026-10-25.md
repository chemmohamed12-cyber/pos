# HR / Attendance / Payroll Integration Architecture Audit — 2026-10-25

**نوع المستند:** تدقيق معماري للقراءة والتوثيق فقط. لم يُكتب أي كود تنفيذي أو ترحيل، ولم يُشغَّل أي backend أو اختبار على قاعدة بيانات، ولم تُلمس `daii_dev` ولا قواعد الشركات، ولم يتغير أي baseline أو إعداد. الالتزام الوحيد: هذا الملف.
**مرجع الكود المقروء:** `HEAD = b661124` على `feature/direct-sale-shipping` (ملفات HR/Attendance/Payroll/Commission/Accounting-payroll/Treasury لم يعدّلها أحد في شجرة العمل — تم التحقق من `git status`).
**ما لا يغطيه:** لم يُشغَّل المتصفح ولا الاختبارات (انظر §14). كل حكم «مختبَر» أدناه يعني: يوجد spec في المستودع يختبره، **لم أعد تشغيله في هذه الجلسة**. أرقام التشغيل الفعلي المذكورة منقولة من وثائق الأدلة الموجودة (WP-PAY-01).

**مفتاح التصنيف** (يُستعمل في كل الجداول):
`[T]` منفَّذ ومختبَر (يوجد spec) · `[P]` جزئي · `[N]` غير موجود · `[U]` غير متحقق منه.

---

## 0. الخلاصة التنفيذية

1. **الدورة موجودة هيكلياً ومفصولة جيداً بين الوحدات** (HR ← Attendance ← Payroll ← Event/Accounting ← Treasury) ولا تكتب وحدة في جداول أخرى مباشرة، وPayroll لا يستورد Accounting إطلاقاً بل ينشر `payroll.run.posted` فقط. هذا يطابق ADR-070/072 ويُحافَظ عليه.
2. **لكن الدورة ليست جاهزة مالياً.** ثلاث مشاكل مقاسة بالتشغيل (WP-PAY-01) وما زالت قائمة في الكود الحالي: (أ) الصرف لا ينشئ أي قيد (Wages Payable لا يُسدَّد أبداً، PA-34)؛ (ب) العمولة تُدفع ولا تُثبَّت محاسبياً (PA-35)؛ (ج) لا يوجد أي اقتطاع (ضريبة/تأمينات/غياب) — `totalDeductions = 0` دائماً (PA-16/37).
3. **ثغرات فصل المهام حقيقية:** قوالب الأدوار الجاهزة (`payroll.manager`، `hr.manager`) تمنح وحدة كاملة بما فيها عقدتان حرجتان (`payroll.run.approve`, `payroll.run.disburse`) وعقدتا `hr.employee.terminate/link_user`؛ الفصل الوحيد المفروض في الكود هو «مُقدِّم طلب الاعتماد ≠ المعتمِد». المراجِع (`review`) لا يُقارَن بالمُعِدّ ولا بالمعتمِد، ولا يوجد SoD على الصرف.
4. **تغيير الأجر بلا اعتماد وبلا تاريخ سريان مُدخَل** (`effectiveFrom = now`) وإعادة حساب مسير مسوَّدة تستعمل الأجر الحالي لا الأجر الفعّال في الفترة. المسير بعد الترحيل ثابت (snapshot) — هذا سليم.
5. **ربط Employee↔User يتجاوز عضوية الشركة:** `linkUser` يتحقق أن المستخدم موجود في المنصة فقط، لا أنه عضو في الشركة، وقائمة الاختيار في الواجهة تستعمل `/admin/users` (كل مستخدمي المنصة، تحت `PlatformGuard`).
6. **لا توجد خدمة ذاتية ولا نطاق «سجلّي أنا» ولا نطاق مدير مباشر ولا كشف راتب (payslip)** في أي طبقة؛ كل قوائم HR/Attendance/Payroll تعيد كل الصفوف لأي حامل صلاحية الوحدة.
7. **الوثائق متأخرة عن الكود:** ADR-070/071/072 ما زالت تحمل «HOLD IMPLEMENTATION / لا يُصرَّح بأي كود» بينما الكود نُفِّذ وأُودع في 2026-09-20 (`7977770`, `6d0fad2`). مَن صرّح بالتنفيذ **غير متحقق منه** من المستودع.
8. القرارات المحاسبية/القانونية التي تُغلق H0-1…H0-9 ما زالت **PENDING** في `DAII-FINAL-DECISION-AND-OWNER-REGISTER-2026-10-14.md`؛ لذلك الخطة (§12) تبدأ بإغلاق العقد قبل أي كود.

---

## 1. حالة التصميم السابق في المستودع (لا إعادة تصميم)

| المستند | الحالة المكتوبة في رأس الملف | الحالة الفعلية للتنفيذ |
|---|---|---|
| ADR-059 HR Phase 0 | APPROVED، Phase 1 مصرَّح؛ قرارات D1–D4 مُلزِمة | منفَّذ (`hr.service.ts`, `1789710xxx` migrations) |
| ADR-062 Attendance study | Proposed (Phase 0) | أساس لـ 063/065 |
| ADR-063 Attendance policy | RATIFIED 2026-09-19 (9 قرارات) | مُطبَّق |
| ADR-065 Attendance Phase 1 | RATIFIED basis | منفَّذ (`b7a3043`) |
| ADR-069 Attendance closure | CLOSED / HANDOFF-READY | — |
| ADR-064 Payroll study | Proposed (Phase 0) | أساس لـ 067/070 |
| ADR-067 Payroll policy | RATIFIED 2026-09-19 | مُطبَّق جزئياً (§D/§E ضريبة وتأمينات «unresolved, not simulated») |
| ADR-068 Commission policy | RATIFIED | مُطبَّق |
| **ADR-070 Payroll contract** | **«CONDITIONAL / HOLD IMPLEMENTATION… No code… authorized»** | **منفَّذ** (`7977770`، نفس يوم تعديل الـ ADR `81d0cbf`) — **رأس الـ ADR لم يُحدَّث** |
| **ADR-071 Commission contract** | **«awaiting CTO review/approval as one package»** | **منفَّذ** (`6d0fad2`) |
| **ADR-072 E2E contract** | **«CONDITIONAL / HOLD IMPLEMENTATION»** | سطح التكامل منفَّذ؛ spec الـ E2E المتكامل موسوم BLOCKED في وثائق Phase 0 |
| DAII-PHASE-0-CONTRACTS-HR-PAYROLL… (2026-10-13) | DRAFT FOR OWNER INPUT؛ PH0-GATE غير مستوفى | يصف H0-1…H0-9 كأسئلة مفتوحة |

**الحكم:** التصريح بتنفيذ 070/071/072 **غير متحقق منه** (لا سجل اعتماد في المستودع، ورأس الوثائق لم يُغيَّر). يوصى بتسجيل قرار CTO صريح يُحدِّث هذه الرؤوس (القرار س-1 في §13).

---

## 2. خريطة الوحدات الحالية

| الطبقة | HR | Attendance | Payroll | Commission/Targets |
|---|---|---|---|---|
| Domain code | `backend/src/domains/hr` (service 588 سطر، controller 264) | `domains/attendance` (service 906، controller 253) | `domains/payroll` (service 610، controller 206) | `domains/commission` (570)، `domains/targets` (210) |
| الكيانات | `Employee`, `EmployeeStatusHistory`, `LeaveRequest` | Connector, EmployeeMapping, RawRecord, ImportBatch, BiometricDailyFact, Day, ApprovalBatch, CorrectionRequest | Period, Compensation, EarningLine, Run, RunLine, AttendanceDayClassification, DeductionLine, Adjustment | Policy, Tier, Result, ApprovalBatch, Adjustment; Target |
| الترحيلات | `migrations/hr/*` (9) | `migrations/attendance/*` (6) | `migrations/payroll/*` (4) | `migrations/commission/*` (5)، `targets/*` (4) |
| Manifest/صلاحيات | `hr.manifest.ts`، `depends_on: []` | `attendance.manifest.ts` (`depends_on: ['hr']`) | `payroll.manifest.ts` (`depends_on: hr, attendance, finance, commission`) | `commission.manifest.ts`، `targets.manifest.ts` |
| قوالب أدوار | `hr.manager`, `hr.viewer` فقط | `attendance.manager/viewer` | `payroll.manager/viewer` | `commission.manager/viewer`، `targets.manager/viewer` (`role-templates.ts:105,154-170`) |
| الواجهة | `pages/hr/{HrEmployees,HrDepartments,HrLeaveRequests}` + `HrCover` | `pages/attendance/{Connectors,Import,BiometricImport,Facts,Days}` + `AttendanceCover` | `pages/payroll/{Periods,Compensation,Runs,RunDetail}` + `PayrollCover` | `pages/commission/*`، `pages/targets/Targets` |
| التنقل | `navigation-registry.ts` (payroll عند السطر 398-402) + `GET /me/navigation` | نفس الآلية | نفس الآلية | نفس الآلية |

**الربط المحاسبي والمالي:**
- Accounting: `payroll-run-posted.handler.ts` (الحدث `payroll.run.posted`، مسجَّل في `finance-handlers.ts:358`, `handler-registry.ts:135`, `financial-event.service.ts:73`)، حساب مصروف ثابت `5201` وحساب التحكم `wages_payable` (الحساب `2150` أُضيف لقالب `ifrs-sme` في `d3ad24b`).
- Treasury: `FinanceTreasuryContract.cashOutForEmployee` (`treasury.service.ts:736-755`) — **non-emitting** (`NO_EMIT`).
- المستخدمون: `foundation/identity` (User في قاعدة المنصة)، `foundation/company/membership*` (Membership)، `foundation/authorization`، `foundation/permission`، `foundation/scope` (نطاق مستودعات فقط).
- **الدمج مع Org Structure Engine** (الفرع/مركز التكلفة) موجود فقط على فرع غير مدموج `feature/org-structure-gate0` (`edc2d7a`)؛ في الشجرة الحالية `Employee` له `departmentId` فقط (`employee.entity.ts`).

---

## 3. مصدر الحقيقة لكل معلومة: المطلوب مقابل المنفَّذ

| المعلومة | المالك المطلوب (طلب CTO / ADR-072) | الواقع المنفَّذ | الحكم |
|---|---|---|---|
| هوية الموظف، الكود | HR | `hr_employees` بكود من `NumberingService` (D4)؛ لا مفتاح طبيعي (رقم قومي/بريد) يمنع التكرار؛ الفهرسان الفريدان: `code` و`userId` | `[P]` — «لا تكرار موظف» غير مفروض إلا بالكود والربط بمستخدم |
| الوظيفة / الفرع / القسم | HR | `position` نص حر، `departmentId` → `org_units(type=department)` (D1)، **لا فرع** ولا مركز تكلفة على الموظف | `[P]` |
| العلاقة الوظيفية | HR | `employmentType` (`full_time/part_time/contractor`), `status`, `hireDate`, تاريخ الإنهاء + `EmployeeStatusHistory` | `[T]` (`hr-phase1.spec.ts`) |
| **أجر الموظف ومكوناته وتاريخ سريانها** | **HR (سجل التعويضات المعتمد)** | **Payroll يملكها:** `PayrollCompensation` + `PayrollEarningLine` (ADR-070 §218 يصرّح «Payroll — Owns and writes»). الكتابة تتم من `payroll.compensation.create` بلا اعتماد، و`effectiveFrom = now` دائماً (`payroll.service.ts:178`) | **تعارض مع طلب CTO** — مطابق لـ ADR-070 لكن مخالف للمصدر المطلوب؛ قرار س-2 |
| البصمات الخام | Attendance | `attendance_raw_records` + `attendance_biometric_daily_facts` | `[T]` |
| الحضور المعتمد | Attendance | `AttendanceDay` + `AttendanceApprovalBatch(status='approved')` عبر FA-01؛ Payroll يقرأ عبر `listApprovedDaysByBatch` فقط (`payroll.service.ts:280-290`) ولا يلمس الخام | `[T]` |
| الدورة ونتيجة كل موظف وصافي الراتب | Payroll | `PayrollRun/RunLine` مع `compensationSnapshot` jsonb؛ فهرس فريد `(run, employee)` و`run` لكل `period` | `[T]` |
| الدليل والقيود والفترات | Accounting | الحدث → handler نقي → `JournalEntryService.post` مع `assertOpenForPosting` | `[T]` للترحيل، `[N]` للصرف |
| الصرف الفعلي | Treasury | `treasury_transactions(type='cash_out', employeeId, payrollRunId)` | `[T]` للحركة النقدية، `[N]` للأثر المحاسبي |
| الدخول والعضوية والأدوار | Users/Authorization | User في المنصة، `Membership` في المنصة، `Role/UserRole` في قاعدة الشركة (ADR-073 Option D) | `[T]` |
| العمولات المعتمدة | Commission | `CommissionResult` ضمن دفعة معتمدة؛ Payroll يقرأ `listApprovedCommissionResults` فقط | `[P]` (انظر G-05) |

**كتابة وحدة في بيانات أخرى:** لم أجد أي كتابة عابرة للوحدات. Payroll يقرأ HR/Attendance/Commission عبر خدمات قراءة، ويكتب فقط في جداوله و`treasury` عبر العقد، وينشر الحدث. **لا تكرار وظائف** سوى أن «الأجر» مملوك لـ Payroll لا HR (أعلاه) وأن `hr.leave_request` وحضور `on_leave` متداخلان بتصميم (ADR-063 §3).

---

## 4. ربط Employee ↔ User

| المتطلب | الواقع | الحكم |
|---|---|---|
| `employeeId` و`userId` منفصلان؛ الربط صريح وقد يغيب | `userId` عمود nullable، فهرس فريد جزئي (`employee.entity.ts`)؛ D2: ربط يدوي بعقدة `hr.employee.link_user` | `[T]` |
| التعيين لا ينشئ حساباً تلقائياً | `createEmployee` لا يلمس المستخدمين (`hr.service.ts:184-231`) | `[T]` |
| مقيَّد بالشركة | الموظف في قاعدة الشركة (ADR-073)، لكن `linkUser` يتحقق فقط `users.findById(userId)` من قاعدة المنصة (`hr.service.ts:397`)؛ **لا فحص `Membership(userId, companyId)`** — يمكن ربط أي مستخدم منصة بموظف شركة لا ينتمي إليها | **`[N]` — ثغرة (G-09)** |
| منع الربط المزدوج | `already linked` على الجانبين (`hr.service.ts:394-402`) | `[T]` |
| فك الربط / إعادة الربط | لا مسار unlink؛ تغيير الربط الخاطئ يتطلب تدخلاً بقاعدة البيانات | `[N]` |
| تعطيل الحساب لا يمحو التاريخ | `userId` يبقى على الموظف؛ لا شيء يُحذف عند تعطيل المستخدم؛ إنهاء الموظف لا يعطّل الحساب ولا يفصل الربط (تصميم مقبول لكنه يترك حساباً فعّالاً لموظف منتهٍ) | `[P]` |
| نطاق رؤية الموظف | لا يوجد: كل `GET /hr/employees`, `/hr/leave-requests`, `/attendance/days`, `/payroll/runs/:id` تُرجع كل الصفوف لأي حامل `*.view`؛ لا فلتر `userId`، لا يوجد مسار «my» | `[N]` — **G-10** |
| نطاق المدير | `managerId` يُخزَّن فقط؛ لا يُستعمل في أي مسار قراءة/اعتماد (بحث `managerId` في domains/foundation لا يُظهر استعمالاً خارج HR CRUD) | `[N]` |
| نطاق مسؤول الرواتب | عقد `payroll.*` كله؛ لا نطاق فرع/قسم | `[N]` |
| مسؤول الرواتب ≠ إدارة المستخدمين | صحيح: لا عقدة `payroll.*` تُعطي إدارة مستخدمين؛ `company_admin` لا يحمل صلاحيات تشغيلية (`role-templates.ts` F3) | `[T]` (F3 specs، غير معاد تشغيلها) |
| التحقق على الخادم عبر العضوية لا `companyId` من الواجهة | `CompanyContextGuard` يحل الشركة من الـ JWT/العضوية؛ كل `hr/payroll/...` تستعمل `req.companyContext.dataSource.manager` | `[T]` (`*.company-isolation.spec.ts`، 4 وحدات) |
| قائمة اختيار المستخدم للربط | الواجهة تجلب `/admin/users` (`HrEmployees.tsx:101`) = `PlatformGuard` + `platform.user.view`، تُرجع **كل** مستخدمي المنصة؛ مسؤول HR العادي يحصل على قائمة فارغة بصمت (التعليق في الكود: «degrades to empty») | `[N]` دليل شركة مقيّد — **G-09** |

---

## 5. الدورة الكاملة: مرحلة بمرحلة

| # | المرحلة | الحالة | الدليل | ملاحظات |
|---|---|---|---|---|
| 1 | تسجيل الموظف | `[P]` | `hr.service.ts:184`; `hr-phase1.spec.ts` | بلا فرع/مركز تكلفة/بيانات صرف/رقم قومي؛ حد `hr.max_employees` مفعّل |
| 2 | ربط المستخدم | `[P]` | §4 | بلا فحص عضوية |
| 3 | الحضور: استيراد → اشتقاق يوم | `[T]` | `attendance.service.ts:642-683`; `attendance-phase1.spec.ts`, `attendance-biometric-import.spec.ts` | تقسيم اليوم بحدود UTC (`T00:00:00Z`) — بصمة 00-03 بتوقيت القاهرة تقع في اليوم السابق؛ مرتبط بقرار DEC-06 (H0-5) المفتوح |
| 4 | الحضور المعتمد (دفعة + FA-01 + تصحيح بعد الاعتماد) | `[T]` | `attendance.service.ts:698-835`; spec E2E-06/07/08 | الدفعة تشمل **كل** الأيام غير المُدفَّعة في المدى (بلا نطاق فرع/قسم) |
| 5 | احتساب المسير بنسخة ثابتة | `[P]` | `payroll.service.ts:247-351`; `payroll-phase1.spec.ts` 1-4, 8 | snapshot ثابت بعد الاحتساب ✓. لكن: الأجر المستعمل هو **النشط حالياً** لا الفعّال في الفترة (`getActiveCompensationWithLines`)؛ كل الشركة بلا نطاق؛ من لا أجر له يُتخطى بصمت؛ من لا حضور معتمد له **يُدفع** (H0-2/PA-37) |
| 6 | يوم غير مصنَّف لا يخصم | `[T]` | `classifyDay` (`payroll.service.ts:223-239`) + spec 2 | آمن: `absent → unclassified/none`؛ لكن النتيجة أن **لا خصم غياب إطلاقاً** |
| 7 | الاعتماد واستقلال الإعداد عن الاعتماد | `[P]` | `approval-engine.service.ts:313`; spec 5 | يمنع فقط أن المُقدِّم يعتمد؛ المُعِدّ/المراجِع غير مقيَّدين |
| 8 | الترحيل `payroll.run.posted` وحدث فريد | `[T]` | handler؛ `UNIQUE(idempotencyKey)` على `FinancialEvent`؛ مفتاح `payroll:PayrollRun:<id>:payroll.run.posted` (`financial-event.service.ts:152`) | إعادة الحدث لا تنتج قيداً ثانياً ✓ (spec isolation + `redrive` يعيد POSTED deduped) |
| 9 | `resolveControlAccount` | `[T]` | handler؛ `wages-payable-control-account.company-isolation.spec.ts` (8 حالات) | الشركات المُنشأة قبل `d3ad24b` بلا الحساب → REJECTED حتى يُنشأ ويُعاد `redrive` |
| 10 | فترة مالية مغلقة | `[P]` | `fiscal-period.service.ts:675` `assertOpenForPosting` | الحدث لا يحمل `orgUnitId` فيُفحص التقويم العام؛ المسير يبقى `posted` والحدث REJECTED والكاشف يلتقطه، والحل الوحيد إعادة فتح الفترة (عقدة حرجة) أو قيد تاريخ جديد — لا مسار تاريخ بديل |
| 11 | الصرف | `[P]` | `payroll.service.ts:529-573`; spec 9, 10 | بوابة `FinancialEvent=POSTED` ✓، قفل استشاري + إعادة فحص ✓، معاملة واحدة لكل المسير ✓؛ **لا قيد** (PA-34)، لا فشل/إعادة جزئية، لا وسيلة دفع |
| 12 | فشل الصرف بعد الترحيل لا يكرر القيد | `[T]` (بالتصميم) | الصرف لا يصدر أي حدث؛ فشله يعيد المعاملة كلها | ليس هناك قيد صرف أصلاً فالشرط محقق بتفاهة |
| 13 | التسوية مع Treasury | `[N]` | — | لا مطابقة صافي ↔ التزام ↔ صرف |
| 14 | التصحيح بعد الترحيل | `[P]` | `createAdjustment` (`:581`) | سجل فقط؛ لا يدخل مسيراً ولا قيداً ولا صرفاً ولا اعتماد |
| 15 | العمولة | `[P]` | `commission.service.ts:457-467`; `payroll.service.ts:307` | تُجمع في الصافي ولا تُرحَّل؛ بلا علامة استهلاك (G-05) |

---

## 6. المحاسبة

| البند | الواقع | الحكم |
|---|---|---|
| شكل القيد | `Dr 5201 (hard-coded code) / Cr wages_payable` بإجمالي `totalGross` فقط (`payroll-run-posted.handler.ts`) | `[T]` لكن ناقص |
| العمولة | `netPay = gross + commission − deductions` (`payroll.service.ts:310`) والقيد = إجمالي الراتب فقط. قياس WP-PAY-01: راتب 4000 + عمولة 200 → قيد 5000.00 للمسير ودفع 5200.00 (العمولة خارج أي قيد) | **`[N]` تثبيت العمولة (PA-35)** |
| الصرف | `NO_EMIT` → لا قيد؛ قياس WP-PAY-01: `financialEventsCreatedByDisburse = 0` | **`[N]` (PA-34)** |
| التعليق الكاذب | عنوان spec 9 يقول «reduces Wages Payable balance» لكن جسمه لا يتحقق من أي رصيد دفتر؛ و`cashOutForEmployee` يزعم أن الأثر «posted already by payroll.run.posted» وهذا غير صحيح (الأخير يرحّل الاستحقاق فقط) | تضليل في الوثائق/الأسماء |
| تاريخ القيد | الحمولة بلا `businessDate` ⇒ `utcBusinessDate()` وقت الاستهلاك أي **يوم الاعتماد** لا نهاية الفترة (`financial-event.service.ts:153`) | `[N]` استحقاق على الفترة الصحيحة (G-06) |
| التوزيع على فرع/قسم/مركز تكلفة | الحمولة بلا `orgUnitId`؛ `PayrollRunLine` بلا بُعد؛ القيد سطران فقط | **`[N]`** |
| منع التكرار | `UNIQUE(idempotencyKey)` + `redrive` idempotent | `[T]` |
| الرفض وإعادة المحاولة | حالة `REJECTED` + `POST /financial-events/:id/redrive` بعقدة `accounting.journal.post`؛ كاشف `listReconciliationGaps` + بطاقة على لوحة الرواتب | `[T]` |
| المطابقة (صافي / التزامات / صرف) | الموجود فقط: «مسير posted بلا حدث POSTED». لا تقرير `wages_payable` مقابل المسيرات ولا فئة في `closing-audit` (لا ذكر payroll/wages في `closing-audit.service.ts` ولا `*reconciliation*.ts`) | `[N]` |
| دقة الأرقام | جمع بـ`Number()` عائم (`:297,308,310,381`)؛ لا توتالات مخزّنة على `PayrollRun`؛ WP-PAY-01 لم يُظهر انحرافاً في 12 سطراً (غير مستبعد للمسيرات الكبيرة) — PA-36 | `[P]` |
| تثبيت ضريبة/تأمينات | لا حسابات ولا قيود ولا سطور (`PayrollDeductionLine` كيان بلا أي كود يكتب فيه؛ عقدة `payroll.deduction.create` بلا مسار) | `[N]` |

---

## 7. الصلاحيات وفصل المهام

### 7.1 العقد الفعلية
`hr.{employee.{view,create,edit,terminate*,link_user*},department.*,leave_request.{view,create,approve}}` · `attendance.{connector,mapping,raw_record,import,manual_entry,day,correction,approval.{view,create,approve}}` · `payroll.{compensation.{view,create},period.{view,create},run.{view,create†,calculate,review,approve*,disburse*},adjustment.create,deduction.create†}` · `commission.{policy,result,batch.{submit,approve},adjustment}`.
`*` حرجة (`permission-risk.ts`: `hr.employee.terminate`, `payroll.run.approve`, `payroll.run.disburse`) · `†` عقدة معرَّفة بلا أي مسار يستعملها (`payroll.run.create`, `payroll.deduction.create`).

### 7.2 المصفوفة المقترحة مقابل الفعلي

| الدور المقترح | العقد المطلوبة (اقتراح) | الدور الجاهز اليوم | الفجوة |
|---|---|---|---|
| مسؤول HR | `hr.employee.{view,create,edit}`, `hr.department.*`, `hr.leave_request.view` | `hr.manager` = **كل** `hr` (يشمل terminate وlink_user والموافقة على الإجازات) | لا دور بلا terminate/link_user |
| مسؤول الحضور | `attendance.{connector,mapping,import,manual_entry,day.view,correction.create,approval.create}` | `attendance.manager` = كل الوحدة (يشمل `approval.approve`) | المُقدِّم والمعتمِد في دور واحد (يمنعه الكود فقط على الطلب الواحد) |
| مدير الفرع | قراءة/اعتماد حضور وإجازات فريقه | **لا يوجد** — لا نطاق فريق | `[N]` |
| الرواتب (مُعِدّ) | `payroll.{period,compensation.view,run.{view,calculate,review}}` | `payroll.manager` = كل الوحدة | يحمل أيضاً `compensation.create`, `run.approve`, `run.disburse` |
| المراجِع | `payroll.run.{view,review}` | لا دور | لا فصل بين المُعِدّ والمراجِع في الكود |
| المعتمِد | `payroll.run.approve` فقط | لا دور | — |
| المحاسب | `accounting.journal.post` (redrive)، قراءة الاستحقاق | `accounting.manager` | — |
| الخزينة | `payroll.run.disburse` + `finance.treasury` | لا دور مجمّع | الصرف مرتبط بـ`payroll.*` لا بـ`finance.*` |
| الموظف | قراءة سجله وإجازاته وكشف راتبه | **لا يوجد** | `[N]` |
| مسؤول النظام | مستخدمون/أدوار فقط | `company_admin` (بلا صلاحيات تشغيلية) | `[T]` ✓ |

### 7.3 فرص تجاوز عبر API مباشر (قراءة كود)
1. `POST /hr/leave-requests` يقبل `employeeId` من الجسم ولا يتحقق أن المنفذ هو صاحب السجل — أي حامل `hr.leave_request.create` يقدّم لأي موظف (`hr.controller.ts`, `hr.service.ts:425`).
2. `POST /payroll/compensations` بلا اعتماد أو سقف أو مراجعة — حامل `payroll.compensation.create` يغيّر أي أجر فوراً؛ التأثير يظهر في أي مسير مسوَّدة يُعاد احتسابه.
3. `POST /payroll/adjustments` يقبل `amountDelta` كنص بلا تحقق عددي، على أي سطر مسير حتى غير المرحَّل، بلا حالة ولا اعتماد (السجل غير مُستهلَك لاحقاً).
4. `POST /payroll/runs/:id/disburse` لا يقارن المنفِّذ بالمُعِدّ/المعتمِد.
5. `POST /payroll/runs/calculate` يُستدعى لأي فترة (حتى المستقبلية أو المتداخلة).
6. قوائم القراءة كلها بلا نطاق (§4)؛ وقراءات بيانات الأجور **غير مدقَّقة** (`audit.record` في Payroll يُستدعى في 8 مواضع كتابة فقط).

---

## 8. قواعد الرواتب المصرية (بلا أي نسب من الذاكرة)

| البند | الواقع | الحكم |
|---|---|---|
| ضريبة كسب العمل | لا حساب، لا جداول، لا حساب دفتر | `[N]` |
| حصة الموظف / صاحب العمل في التأمينات | لا حساب، لا حدود، لا حسابات | `[N]` |
| بدلات خاضعة / غير خاضعة | `componentCode` نص حر؛ لا كتالوج مكونات ولا خاصية خضوع | `[N]` |
| تسويات سنوية | لا | `[N]` |
| فئات التوظيف | `full_time/part_time/contractor` فقط؛ المقاول يُستبعد من المسير | `[P]` |
| فصل القواعد عن الواجهة | الواجهة لا تحتوي منطق حساب (تعرض ما يعيده الخادم) ✓ | `[T]` |
| جداول بتاريخ سريان وثبات تاريخي لكل مسير | لا جداول؛ المتاح فقط `compensationSnapshot` للأجر | `[N]` |

**المطلوب من محاسب رواتب مصري مختص (قبل أي كود):** تحديد المرجع القانوني لكل من الضريبة والتأمينات والبدلات وفئات التوظيف والتسويات السنوية؛ توقيع من يملك جداول الشرائح والحدود وتواريخ سريانها؛ أمثلة ذهبية (golden fixtures) عند حدود الشرائح؛ قاعدة تُطبَّق على التاريخ (شهر الاستحقاق أم الصرف). لا أضع أي رقم هنا. هذا يطابق H0-1 (`PAYROLL_POLICY_OWNER`).

---

## 9. تجربة الاستخدام الحالية (جرد فجوات — دون تشغيل المتصفح)

| العنصر | الواقع (من قراءة الكود) |
|---|---|
| لوحات | `HrCover/AttendanceCover/PayrollCover` تعرض اختصارات و1-2 مؤشر (مسيرات غير مرحَّلة، فجوات مطابقة)؛ لا لوحة «جاهزية دورة الرواتب» |
| الخدمة الذاتية | لا شيء |
| كشف الراتب | لا شيء (H0-3) |
| «الخطوة التالية» | حالة المسير تُعرض بثلاث شارات مستقلة (PayrollRun / Financial Event / Treasury) ✓ ورسالة توضيح `panel.payroll_three_states_notice`؛ زر الصرف معطّل مع `title` إنجليزي ثابت؛ لا نص يشرح للمعتمِد ماذا بعد |
| مصطلحات AR/EN | تُحمَّل عبر `preload([...codes])` وجدول `terminology_entries` (ترحيلات Seed*Terminology) ✓ |
| نصوص ثابتة بالإنجليزية | `'Failed to load …'`, `"Loading…"`, `'Attendance Status'`, `'⚠ Reconciliation gap'`, `'Financial Event must resolve POSTED first'` في `PayrollRunDetail.tsx` و`HrEmployees.tsx`/`PayrollRuns.tsx` |
| RTL/LTR | `LanguageContext.tsx`, `Layout.css`, `print.css` تتعامل مع `dir`؛ جداول الرواتب/الأيام لم تُفحص بصرياً |
| الاستجابة (موبايل) | غير متحقق منه |
| اختيار الموظف | نص `code — fullName` بلا بحث/ترشيح؛ `PayrollRunDetail` يجلب كل الموظفين عبر `/hr/employees` ويتطلب `hr.employee.view` لدى مسؤول الرواتب |
| إدخال الأجر | `PayrollCompensation.tsx` — مكوّنات حرة بلا تاريخ سريان ولا سبب ولا مقارنة بالسابق |

---

## 10. سجل الفجوات (Gap Register)

الأولوية: **P0** يمنع الاستعمال المالي · **P1** خطر تشغيلي · **P2** تحسين/اتساق.

| ID | الفجوة | الدليل | أولوية | القرار المطلوب |
|---|---|---|---|---|
| G-01 | الصرف بلا قيد؛ `wages_payable` لا يُسدَّد (PA-34) | `payroll.service.ts:555`, `treasury.service.ts:736-755`, WP-PAY-01 | P0 | س-3 (H0-4) |
| G-02 | العمولة تُدفع ولا تُثبَّت (PA-35) | `payroll.service.ts:310,477`, handler | P0 | س-3, DEC-04 |
| G-03 | لا SoD بين الإعداد/المراجعة/الاعتماد/الصرف؛ قوالب الأدوار وحدة كاملة | `approval-engine.service.ts:313`, `role-templates.ts:105,154` | P0 | س-4 |
| G-04 | تغيير الأجر بلا اعتماد/سبب/تاريخ سريان؛ إعادة الاحتساب بالأجر الحالي | `payroll.service.ts:162-211,294` | P0 | س-2 |
| G-05 | العمولة بلا علامة استهلاك، نافذة بـ`calculationTimestamp`، وفترات رواتب قد تتداخل (فهرس فريد على `code` والمسير لكل فترة فقط) ⇒ احتمال عد مزدوج/فقدان | `commission.service.ts:457`, `CreatePayrollCore.ts:27,82` | P1 | س-5 |
| G-06 | تاريخ القيد = يوم الاعتماد؛ بلا `orgUnitId`/بُعد؛ الفترة المغلقة تُوقف الحدث بلا بديل | `financial-event.service.ts:153`, handler | P1 | س-3 |
| G-07 | صرف كتلة واحدة: لا جزئي ولا إعادة إصدار ولا وسيلة دفع ولا بيانات بنكية | `payroll.service.ts:547-560` | P1 | H0-6 |
| G-08 | لا فحص تغطية حضور؛ بلا تقويم عطلات؛ UTC مقابل القاهرة | `payroll.service.ts:278-290`, `attendance.service.ts:642` | P1 | H0-2, DEC-06 |
| G-09 | ربط Employee↔User بلا عضوية شركة؛ قائمة اختيار منصّية؛ لا unlink | `hr.service.ts:392-405`, `HrEmployees.tsx:101` | P1 | — |
| G-10 | لا خدمة ذاتية/نطاق موظف/مدير/فرع؛ لا كشف راتب؛ قراءات رواتب بلا تدقيق | §4, §7.3 | P1 | H0-9 |
| G-11 | HR master ناقص: فرع، مركز تكلفة، رقم قومي، وظيفة منظَّمة، بيانات صرف، مرفقات | `employee.entity.ts` | P1 | H0-7 |
| G-12 | لا اقتطاعات قانونية؛ `PayrollDeductionLine` بلا كاتب؛ لا كتالوج مكونات | `payroll.service.ts:301` | P1 | H0-1 |
| G-13 | `PayrollAdjustment` سجل صامت غير مُستهلَك، بلا اعتماد ولا تحقق عددي ولا حالة | `payroll.service.ts:581-605` | P2 | س-6 |
| G-14 | حساب عائم وبلا مجاميع مخزّنة (PA-36) | `payroll.service.ts:297-310` | P2 | — |
| G-15 | لا مطابقة شاملة ولا فئة في closing-audit | §6 | P2 | H0-4 |
| G-16 | انجراف وثائقي: رؤوس 070/071/072 و«reduces Wages Payable» و«already posted by…» | §1, §6 | P2 | س-1 |
| G-17 | `PayrollPeriod.status` لا يتغير أبداً (`open` للأبد)، لا إقفال ولا منع فترات مستقبلية/متداخلة | `payroll.service.ts:137-151` | P2 | — |
| G-18 | نصوص إنجليزية ثابتة، لا إرشاد «الخطوة التالية» لكل دور | §9 | P2 | — |
| G-19 | بُعد الفرع/مركز التكلفة موجود فقط على فرع `feature/org-structure-gate0` غير المدموج | §2 | P1 | س-7 |
| G-20 | عكس العمولة عند إلغاء/مرتجع فاتورة (PA-38): الاشتراكات الحالية `finance.invoice.posted` و`collection.remitted` وأحداث الاعتماد فقط | `commission.service.ts:99-125` | P1 | H0-8 |
| G-21 | عقدتا `payroll.run.create` و`payroll.deduction.create` معرَّفتان بلا استعمال (سطح صلاحيات ميت) | `payroll.manifest.ts` | P2 | — |

### مخاطر التغيير
1. **تغيير شكل القيد (G-01/02):** يغيّر أرصدة `wages_payable` التاريخية — يحتاج سياسة ترحيل للمسيرات القائمة (لا يُعاد كتابتها؛ قيود تسوية افتتاحية).
2. **نقل ملكية الأجر إلى HR (س-2):** يمس ADR-070 §218 وجداول `payroll_compensations` ويؤثر على كل fixtures؛ البديل الأرخص: إبقاء الجدول في Payroll ومنح HR قراءة/اعتماداً عبر عقد.
3. **تقييد الأدوار (G-03):** يقلّص صلاحيات حسابات قائمة؛ قوالب الأدوار «لا تُطبَّق تلقائياً» على الشركات القائمة (F3) فيلزم مسار ترقية قوالب موثّق.
4. **تقويم العطلات (G-08):** يغيّر نتيجة `classifyDay` من «لا خصم» إلى خصم محتمل — لا يُفعَّل قبل H0-2.
5. **تداخل مع فروع أخرى:** `feature/org-structure-gate0` و`feature/manufacturing-engine-design` وغيرها؛ أي عمل بُعدي يجب أن يُبنى فوق Org Engine بعد دمجه.

---

## 11. معايير القبول المطلوبة مقابل الواقع

| المعيار | الحالة اليوم | الدليل/السبب |
|---|---|---|
| لا تكرار موظف | `[P]` | كود فريد وربط مستخدم فريد فقط |
| تغيير الأجر لا يعدّل فترات سابقة | `[P]` | صحيح لمسير محسوب (spec 8)؛ خاطئ لإعادة احتساب مسوَّدة |
| لا خصم من غياب غير مصنَّف | `[T]` | spec 2 |
| لا احتساب من حضور غير معتمد | `[T]` | يقرأ دفعات `approved` فقط؛ لكن غياب الحضور المعتمد ⇒ دفع كامل (مخالف لروح المعيار) |
| لا ترحيل لمسير غير معتمد | `[T]` | الحدث يُنشر فقط من معالج الاعتماد |
| لا ترحيل لفترة مغلقة | `[T]` | بوابة الترحيل؛ لكن بلا مسار تعافٍ سوى إعادة فتح الفترة |
| إعادة الحدث لا تنشئ قيداً ثانياً | `[T]` | `UNIQUE(idempotencyKey)` |
| فشل الصرف بعد الترحيل لا يكرر القيد | `[T]` بالتفاهة | لا قيد صرف أصلاً |
| الموظف لا يرى رواتب غيره | `[N]` | لا نطاق موظف؛ حامل `payroll.run.view` يرى الجميع |
| كل مسير قابل لإعادة التفسير | `[P]` | snapshot الأجر + تصنيفات الأيام ✓؛ لا تحليل قاعدة/نسخة سياسة ولا خطوات حساب |
| مطابقة الصافي والالتزامات والصرف | `[N]` | G-01, G-15 |

---

## 12. خطة المراحل المحدودة (مقترحة — لا تنفيذ)

> كل مرحلة تنتهي بتسليم وانتظار مراجعة. لا مرحلة تبدأ قبل اعتماد سابقتها. لا merge/release بدون قرار منفصل.

**المرحلة 0 — مراجعة المستودع (هذا التقرير).** المخرج: هذا الملف + قرارات س-1…س-8.

**المرحلة 1 — إغلاق عقد التكامل (وثائق فقط).**
- تحديث رؤوس ADR-070/071/072 وتسجيل مصدر التصريح (س-1).
- توقيع H0-4 (شكل القيد: إجمالي/عمولة/اقتطاعات/صرف/جزئي)، H0-2، H0-6، H0-9، وقرار ملكية الأجر (س-2)، وDEC-06.
- ملحق «خريطة مصدر الحقيقة» المعتمدة (§3).
- قبول: لا بند PENDING يمس الكود التالي؛ fixtures ذهبية موقّعة (المبلغ = مجموع المكوّنات = القيد = النقد).

**المرحلة 2 — ربط الموظفين والصلاحيات.**
- فحص عضوية الشركة في `linkUser` + دليل مستخدمين على مستوى الشركة + unlink مُدقَّق.
- أدوار قوالب مقسّمة (مسؤول HR، إعداد رواتب، مراجِع، معتمِد، صرف، موظف) + SoD: المُعِدّ ≠ المراجِع ≠ المعتمِد ≠ منفِّذ الصرف.
- نطاق «سجلي» ونطاق المدير عبر `managerId`، وتدقيق قراءات الأجور.
- قبول: موظف يطلب راتب غيره = 403/404؛ `linkUser` لمستخدم من خارج الشركة = رفض؛ ثلاثة مستخدمين مختلفين شرط للمسير؛ A/B isolation يحصي كل غير-200.

**المرحلة 3 — دورة الرواتب.**
- الأجر بتاريخ سريان مُدخَل + اعتماد التغيير + اختيار الأجر الفعّال للفترة؛ كتالوج مكونات؛ منع تداخل الفترات؛ علامة استهلاك العمولة؛ سياسة غياب/تغطية حضور حسب H0-2؛ حساب عشري دقيق (decimal helper) وتوتالات مخزّنة؛ `Adjustment` يدخل المسير التالي.
- قبول: مسير قديم لا يتغير بعد رفع أجر؛ فترتان متداخلتان مرفوضتان؛ عمولة لا تُحتسب مرتين؛ property test: مجموع الأسطر = الإجمالي لقيم سنت عشوائية.

**المرحلة 4 — التكامل المحاسبي والمالي.**
- حسب H0-4: تثبيت العمولة، قيد الصرف `Dr Wages Payable / Cr Treasury`، بُعد فرع/قسم/مركز تكلفة (بعد دمج Org Engine)، تاريخ القيد = نهاية الفترة (أو القاعدة المعتمدة)، مسار تعافٍ للفترة المغلقة، مطابقة `wages_payable` وفئة closing-audit؛ صرف جزئي/فاشل حسب H0-6.
- قبول: رصيد `wages_payable` بعد مسير + صرف كامل = 0؛ إعادة الحدث لا تخلق قيداً؛ فشل صرف جزئي لا يكرر شيئاً؛ مسير لفترة مغلقة يُرفض بوضوح ويُعاد بعد المعالجة.

**المرحلة 5 — القواعد القانونية المصرية (مشروطة بمحاسب رواتب مختص).** جداول بتاريخ سريان، لقطة قواعد لكل مسير، golden fixtures. لا تبدأ قبل P1 في سجل القرارات.

**المرحلة 6 — تجربة الاستخدام.** لوحة جاهزية، رسائل «الخطوة التالية» لكل دور، خدمة ذاتية، كشف راتب (H0-3)، إزالة النصوص الثابتة، فحص RTL/موبايل في المتصفح.

**المرحلة 7 — اختبارات شاملة وتسليم.** تشغيل E2E المتكامل (المحجوب حالياً)، 4 وحدات isolation + مصفوفة أدوار، اختبار 00-03 بتوقيت القاهرة، تقرير تسليم؛ المراجعة المستقلة إن توفّر مراجِع.

---

## 13. أسئلة القرار المفتوحة

- **س-1:** من صرّح بتنفيذ ADR-070/071/072 وبأي تاريخ؟ هل يُحدَّث رأس كل منها إلى «منفَّذ جزئياً — مع الاستثناءات G-01/02/12»؟
- **س-2:** ملكية الأجر: إبقاؤه في Payroll (ADR-070 §218) مع عقد اعتماد HR، أم نقل السجل إلى HR؟ وهل يُشترط اعتماد (FA-01) لكل تغيير أجر؟
- **س-3:** H0-4 (ACCOUNTING_POLICY_OWNER + CTO): مبلغ الترحيل (إجمالي أم إجمالي+عمولة)، حساب مصروف العمولة وتوقيتها، قيد الصرف، تاريخ القيد (نهاية الفترة أم الاعتماد)، سلوك الفترة المغلقة، وتوزيع الفروع/مراكز التكلفة.
- **س-4:** قاعدة SoD المطلوبة بالضبط: هل يمتنع المُعِدّ عن المراجعة؟ هل يمتنع المعتمِد عن الصرف؟ هل للمراجِع عقدة مستقلة (`payroll.run.review` موجودة فعلاً)؟
- **س-5:** سياسة العمولة في الرواتب: بأي تاريخ تُنسب (الاحتساب أم الاعتماد أم التحصيل)، وما الحل لعمولة تُعتمد بعد إقفال مسير فترتها؟
- **س-6:** هل `PayrollAdjustment` يُطبَّق في مسير لاحق أم بمسير تصحيح مستقل أم بقيد يدوي؟
- **س-7:** هل ننتظر دمج `feature/org-structure-gate0` قبل المرحلة 4، وهل يُضاف `branch` للموظف الآن؟
- **س-8:** سياسة الموظف المنتهي: تعطيل تلقائي لحسابه/عضويته أم يدوي؟ (يترك حالياً حساباً فعّالاً).
- **قرارات خارجية معلّقة (من سجل 2026-10-14):** H0-1 محاسب رواتب، H0-2 تقويم/غياب، H0-3 payslip، H0-6 صرف، H0-7 HR master، H0-8 عكس العمولة، H0-9 رؤية الرواتب، DEC-06 التوقيت.

---

## 14. ما لم أستطع التحقق منه ولماذا

| البند | السبب |
|---|---|
| نتائج الاختبارات الحالية (payroll/hr/attendance/commission specs) | جميعها تعتمد AppModule وقاعدة PostgreSQL ولا توجد في قائمة `unit-specs.txt` DB-free؛ ممنوع التشغيل على `daii_dev`، ولم يُشغَّل عنقود الاختبار المعزول لأن المهمة قراءة/توثيق فقط |
| الأرقام المقاسة لـ WP-PAY-01 | منقولة من وثيقة Phase 0 و spec التوصيف؛ لم تُعَد |
| سلوك الواجهة (RTL/موبايل/الرسائل الفعلية) | لم يُشغَّل المتصفح/نسخة الواجهة |
| من صرّح بتنفيذ 070/071/072 | لا سجل في المستودع |
| قرارات مالك السياسات | وثائق REQUEST-* حالتها PENDING في السجل |
| `Targets`/`Commission` UI وقواعد حساب العمولة بالتفصيل | خارج نطاق التدقيق المطلوب (فُحص السطح الذي يستهلكه Payroll فقط) |
| هل يوجد تعارض ترقيم `PR` بين `payroll_run` وأنواع مستندات أخرى | لم أُثبت تعارضاً؛ لم أتحقق من كل أنواع الترقيم |
| أي تغيير في فروع/worktrees أخرى (org-gate0 وغيرها) غير مدموج | قُرئت أوصافها فقط |

---

## 15. ملحق: ملفات مرجعية رئيسية

`backend/src/domains/payroll/application/payroll.service.ts` · `…/interface/payroll.controller.ts` · `backend/src/domains/accounting/application/financial-events/payroll-run-posted.handler.ts` · `…/financial-event.service.ts` · `backend/src/domains/treasury/application/treasury.service.ts:520-760` · `backend/src/domains/hr/application/hr.service.ts` · `backend/src/domains/attendance/application/attendance.service.ts` · `backend/src/domains/commission/application/commission.service.ts` · `backend/src/foundation/module-registry/{role-templates.ts,manifests/payroll.manifest.ts}` · `backend/src/foundation/permission/permission-risk.ts` · `backend/src/foundation/approval-engine/approval-engine.service.ts:313` · `backend/docs/decisions/{ADR-059,063,065,067,069,070,071,072}-*.md` · `backend/docs/decisions/DAII-PHASE-0-CONTRACTS-HR-PAYROLL-MANUFACTURING-2026-10-13.md` · `…/DAII-FINAL-DECISION-AND-OWNER-REGISTER-2026-10-14.md` · `…/WAGES-PAYABLE-CONTROL-ACCOUNT-TEMPLATE-2026-10-13.md` · `frontend/src/pages/{hr,attendance,payroll,commission}/*`.
