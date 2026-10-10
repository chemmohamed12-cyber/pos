# G0 — Existing-test scan, traceability matrix and gap list (step 1, read-only)

> **R3 (2026-10-10):** هذه المسودة الأولى معتمدة كمسح أولي فقط؛ المراجعة التكميلية بقراءة أجسام الاختبارات في `G0-SUPPLEMENTARY-REVIEW-2026-10-10.md` (تحدّث تصنيفات الأدلة، وتسجل العيب المرشح F-INV-001، ونتائج D-2).

التاريخ: 2026-10-10 · الحالة: **مسودة للمراجعة** · نوع العمل: قراءة فقط (كود، أسماء الاختبارات، وثائق). لم يُشغَّل أي اختبار ولم يُلمس أي بيئة. الإصدار المفحوص: commit `4381935` (master، وفوقه تعديلات LA-1 غير مدمجة في مسار القراءة).
المنهج: استخراج آلي لأسماء الاختبارات (`it/test`) من 195 ملف spec + قراءة الكود عند الحاجة. **ما هو مكتوب في اسم الاختبار لا يعني أنه يُثبت السلوك؛ لم أقرأ جسم كل اختبار.** التصنيفات: E = اختبار منفذ على قاعدة PostgreSQL حقيقية (استدلال بالاسم/المحتوى)، U = وحدة/محاكاة (mock)، D = تصميم/وثيقة فقط، X = لا شيء.

## 1. الجرد (VERIFIED بعدّ آلي)
- 195 ملف spec، **1273 اختبارًا**. ملفات تستخدم PG حقيقية (استدلال): 93. ملفات `*company-isolation*`: 65. ملفات تذكر تزامنًا/Promise.all/سباقًا: 16.
- اختبارات HTTP داخل jest: ~2 فقط (استدلال بحثي). التحقق عبر HTTP الحقيقي (F1–F6، closure، security-mutation، revocation) موجود كـ**سكربتات يدوية** في `docs/decisions/authz-tools/` تُشغَّل ضد بيئة العزل **وليست جزءًا من الانحدار الآلي** → نتائجها غير محمية من التراجع.
- توزيع الملفات: accounting 28 · foundation/company 30 · foundation/release 27 · procurement 13 · manufacturing 5 · returns 4 · inventory-warehouse 4 · customer-finance 4 · treasury 2 · sales-orders 2 · shipment 1 · fulfillment 1 · delivery 1 · deposit-control 1 · باقي المجالات 1–7.

## 2. تصحيحات على الوثائق السابقة (A/C) بناءً على القراءة
| البند | ما قلته سابقًا | الواقع بعد المسح |
|---|---|---|
| تحصيل/دفعة على الحساب | «غير مغطى» | `on-account-payment.company-isolation.spec` (E): فشل قبل أي تعديل عند مبلغ ≤ 0 أو حساب غير مربوط أو أمر عميل آخر؛ رفض تطبيق > غير المطبق أو > المستحق. مغطى جزئيًا. |
| سقف المرتجع | «تصميم فقط» | `returns-accounting.company-isolation.spec` (E): بند 2 سقف الكمية، 5b عكس الفاتورة بدقة، 10 مصدر غير صالح → صفر تعديل، 15 القيود متوازنة وΣ التقييم = GL المخزون 1120. مغطى. |
| فاتورة مورد | — | `supplier-invoice-ppv-vat.company-isolation.spec` (E): VOID يعيد كل شيء ذريًا؛ رفض قبل التعديل عند غياب حساب PPV/VAT. |
| تكرار الحدث | «غير مثبت» | `event-engine.company-isolation.spec` (E): 3 dispatchers متزامنة تعالج كل صف مرة واحدة (SKIP LOCKED)؛ فشل handler يترك الصف قابلًا لإعادة المحاولة في شركته فقط. `treasury.company-isolation`: IdempotencyService لا يتصادم بين الشركات. |
| تزامن الشركات | — | `company-users.f2`: قبول دعوة متزامن → واحد فقط؛ `installation-bootstrap`: 8 تشغيلات متزامنة → صف واحد؛ `company-lifecycle-admission` (LA-1، غير مدمج). |
| الصرف أكثر من المتاح | «لا دليل» | **الحراسة موجودة في الكود** (VERIFIED بقراءته): `inventory.service.ts:808,865,1643`, `warehouse-transactions.service.ts:569` («nothing was posted»), `treasury.service.ts:343`, `work-order.service.ts:381,481`. **لم أجد اختبارًا يُشغّلها** عدا أمر التصنيع (`work-order.spec`) → فجوة اختبار وليست فجوة كود. |
| الاختبار الأكثر دلالة | — | `returns-accounting` وبنود `fail-closed` تغطي «الإعداد المحاسبي مفقود → رفض قبل التعديل» في 10+ ملفات. |

## 3. مصفوفة التتبع (G0) — الإصدار الأول
المخاطر: ح = حرج، ع = عالٍ، م = متوسط. الحالة: ✔ متحقق (E + مراجعة اسم)، ◐ جزئي، ✖ غير مغطى، ⚠ مفتوح/عيب.
| REQ | المتطلب | م | البوابة | الدليل الحالي (ملف/اختبار) | التصنيف | الحالة |
|---|---|---|---|---|---|---|
| REQ-ISO-001 | A↔B مرفوض على API دون تعديل (404/401/403) | ح | G3 | 65 company-isolation (E) + `security-mutation-verification.js` (سكربت يدوي) | VERIFIED على بيئة عزل | ◐ (تصدير/ملفات/مهام/استضافة غير مغطاة) |
| REQ-ISO-002 | إلغاء الصلاحية/العضوية/النطاق فوري | ح | G3 | `area6-company-isolation.acceptance.spec` (U)، `company-context.guard.spec` (U)، `revocation-immediacy-result.txt` (سكربت) | VERIFIED | ✔ (غير محمي بالانحدار الآلي في جزء HTTP) |
| REQ-ISO-003 | حالة الشركة غير READY تحجب الطلبات فورًا | ح | G3 | `company-lifecycle-layer1.real-pg.spec` (E) | VERIFIED | ✔ |
| REQ-ISO-004 | قيد النطاق للمستودع (تصدير المخزون) | ع | G3 | `stock-report-export.scope.spec` (U) + سكربتات F6 | VERIFIED | ◐ |
| REQ-INV-001 | مستودع غير معروف → 404 قبل التعديل | ع | G1 | `warehouse-reference.company-isolation.spec` (E) | VERIFIED | ✔ (work-order: فجوة معروفة) |
| REQ-INV-002 | منع الصرف > المتاح (صرف، تحويل، حجز، مستودع، خزينة) | ح | G1 | الكود فقط (D) | UNVERIFIED سلوكيًا | ✖ |
| REQ-INV-003 | الرصيد لا يُعدَّل إلا عبر دفتر الحركات | ح | G1 | لا اختبار مباشر؛ `recordMovement` يُختبر عبر العزل (E) | UNVERIFIED | ✖ |
| REQ-INV-004 | سقف المرتجع = min(sold, shipped) | ع | G1 | `returns-accounting` بند 2 (E) | VERIFIED | ✔ |
| REQ-INV-005 | الحجز لا يُستخدم مرتين / لا تجاوز الحجز | ح | G1/G2 | لا اختبار مباشر (`getAvailable`/reservations تُقرأ فقط) | UNVERIFIED | ✖ |
| REQ-INV-006 | تحويل داخلي ليس بيعًا (لا إيراد/COGS) | ع | G1 | لم أجد | UNVERIFIED | ✖ |
| REQ-SAL-001 | تجاوز مراحل الاعتماد/سير العمل ممنوع | ح | G1/G3 | Approval Engine (اختبارات foundation/approval-engine، 2 ملفات) | INFERRED | ◐ (لم تُفحص) |
| REQ-SAL-002 | تعديل كمية بعد الاعتماد يعيد فحص التوافر | ع | G1 | كود (`sales-orders.service.ts:901` تعليق: يتراجع الإضافة عند نقص) | INFERRED | ✖ كاختبار |
| REQ-FIN-001 | تحصيل بمبلغ مطابق، رفض ≤0، رفض التطبيق الزائد | ح | G1 | `on-account-payment.company-isolation.spec` (E) | VERIFIED | ◐ |
| REQ-FIN-002 | منع تحصيل/ترحيل مكرر (idempotency على مستوى HTTP/إعادة الإرسال) | ح | G2 | `IdempotencyService` معزول بين الشركات (E)؛ إعادة الإرسال الفعلية لم تُختبر | INFERRED | ✖ |
| REQ-FIN-003 | حساب بنك مربوط وإلا رفض قبل التعديل | ع | G1 | `treasury-bank-leg.company-isolation.spec` (E) | VERIFIED | ✔ |
| REQ-FIN-004 | قيود متوازنة، Σ تقييم = GL المخزون | ح | G1 | `returns-accounting` 15، `grni/wip-reconciliation` (U)، `inventory-posting` (E) | VERIFIED جزئيًا | ◐ (لا مصالحة شاملة مستقلة) |
| REQ-FIN-005 | فشل ترحيل القيد لا يمرّر بصمت (fail-closed، REJECTED، قابل لإعادة المحاولة) | ح | G1/G2 | `event-engine`, `returns-accounting 11b`, `manual-receipt 5c` (E) | VERIFIED | ✔ |
| REQ-AUD-001 | سلسلة التدقيق متزامنة/صحيحة (اختبار) | ح | G3 | `audit-chain-concurrency.real-pg.spec` (E) | VERIFIED | ✔ للاختبار |
| REQ-AUD-002 | سلسلة تدقيق الإنتاج سليمة | ح | G3 | تقرير: مكسورة عند `seq 1` | OPEN | ⚠ (انظر الوثيقة AUDIT-SEQ1) |
| REQ-AUD-003 | منع حذف/تعديل سجل الحركات والتدقيق دون مسار تصحيح | ح | G1/G3 | سلسلة الهاش تكشف التعديل (تصميم)؛ لا اختبار حذف مباشر؛ لا حماية DB (triggers) مفحوصة | INFERRED | ✖ |
| REQ-CON-001 | تزامن ترقيم القيود/deadlock retry | ع | G2 | `f03-deadlock-retry-verification` (U)، `journal-numbering.company-isolation` (E) | VERIFIED جزئيًا | ◐ |
| REQ-CON-002 | تزامن تخصيص قواعد الشركات | ع | G2 | `company-database-allocation.http`, `pool.multi-process` (E) | VERIFIED | ✔ |
| REQ-CON-003 | تزامن صرف المخزون/خصم الخزينة من نفس الرصيد | ح | G2 | لا شيء | UNVERIFIED | ✖ |
| REQ-REL-001 | فحص بيئة قبل التبديل، جاهزية HTTP، تراجع تلقائي | ح | G5 | `release-execution-readiness.spec`, `release-execution-gates.spec` (U) | VERIFIED على الوحدة؛ الاستضافة أنتجت حوادث 1.1.4–1.1.7 | ◐ |
| REQ-REL-002 | بوابة الترحيلات: registry، preflight، expand/contract | ح | G5 | `migration-preflight`, `expand-contract-guard`, `release-migration-registry.real-pg` (E/U) | VERIFIED | ✔ |
| REQ-REL-003 | fan-out للشركات: backup قبل الترحيل ويمنع عند الفشل | ح | G5 | `company-fanout.real-pg.spec` (E) | VERIFIED على PG معزولة | ◐ (مغلق افتراضيًا على الاستضافة) |
| REQ-CAP-001 | حدود سعة مقيسة ببيئة محددة | ع | G4 | لا شيء | UNVERIFIED | ✖ |
| REQ-E2E-001 | دورة شراء→استلام→فاتورة→سداد تتطابق الأرصدة | ح | G6 | `grni-posting.spec` (U)، `supplier-invoice-ppv-vat` (E)، `goods-receipt.company-isolation` (E) — لا دورة كاملة واحدة | INFERRED | ◐ |
| REQ-E2E-002 | دورة بيع→شحن→فاتورة→تحصيل→مرتجع | ح | G6 | `returns-accounting` (E) يغطي جزءًا كبيرًا (SETUP عبر مسارات حقيقية) | VERIFIED جزئيًا | ◐ |
| REQ-E2E-003 | تصنيع→WIP→تكلفة | ع | G6 | `work-order-phase3-e2e` (U) | VERIFIED على وحدة | ◐ |
| REQ-E2E-004 | دورة الرواتب/الحضور/العمولات إلى GL | م | G6 | `integrated-attendance-payroll-commission-gl-e2e` (U) | VERIFIED على وحدة | ◐ |

## 4. قائمة الفجوات (مرتبة بالمخاطر)
1. **REQ-INV-002/003/005/006 + REQ-CON-003** (حرجة): حراسات المخزون والخزينة موجودة بالكود بلا أي اختبار يشغّلها؛ لا اختبار تزامن لرصيد واحد؛ لا اختبار لتجاوز الحجز ولا لتحويل داخلي ≠ بيع.
2. **REQ-FIN-002** (حرجة): إعادة إرسال الطلب (HTTP) وتكرار التحصيل لم تُختبر؛ ما يُثبت فقط عزل IdempotencyService.
3. **REQ-AUD-002** (حرجة، مفتوحة) و**REQ-AUD-003**: لا تشخيص؛ لا فحص لحماية الحذف/التعديل على مستوى DB.
4. **سكربتات HTTP غير آلية** (عالية): نتائج F1–F6 والعزل لا تعمل ضمن الانحدار → خطر تراجع صامت. يلزم قرار: إدراج بعضها في خط آلي على بيئة عزل.
5. **G2 كاملة** (حرجة): انقطاع DB وسط عملية، مهلة بعد حفظ ناجح، إعادة تشغيل التطبيق، تأخر المهام: لا اختبارات (باستثناء استئناف التزويد وإعادة محاولة الأحداث).
6. **G3 الموسّع** (عالية): التصدير، البحث، التقارير، الملفات، المهام الخلفية، الأسرار في الاستجابات/السجلات.
7. **G4/TEST-01** (عالية): لا شيء مقيس.
8. **G6** (عالية): لا دورة كاملة مؤتمتة موحدة؛ ما هو موجود قطع متجاورة.
9. **مصالحة مستقلة** (حرجة): REQ-FIN-004 جزئي (يُختبر في سيناريوهات مختارة) بلا تقرير مصالحة شامل بتفسير الفروق.
10. **الاعتماد على اختبارات U**: عدد من اختبارات المحاسبة/الرواتب/الحضور على mock؛ تُحسب «وحدة» لا «سلوك فعلي».

## 5. حدود هذا المسح
لم أقرأ جسم كل اختبار؛ صنّفت بالاسم والمحتوى الظاهر. أي صف «✔» يحتاج مراجعة مراجع قبل الإغلاق. لم أفحص: الواجهة الأمامية، أدوات الاستضافة، سكربتات النشر، ولا قواعد الإنتاج.
