# F-INV-001 — تتبّع المسار، مصفوفة العقد، وتوصية إصلاح واحدة (قراءة فقط)

الحالة: عيب مرشح، **غير مؤكد باختبار HTTP**. لا تعديل كود، لا حذف/تعطيل للمسار (قرار CTO D-11: مبدأ معتمد، تنفيذ غير معتمد). التصنيف VERIFIED = قراءة نص الكود؛ INFERRED = استنتاج من الكود دون تشغيل؛ UNVERIFIED = لا دليل.

## 1. تتبّع المسار من الواجهة إلى القاعدة والأحداث
`POST /api/inventory/movements`
1. **Controller** `inventory.controller.ts:349-380`: `@UseGuards(PermissionGuard)` · `@RequirePermission('inventory.movement.create','editable')` · `@WarehouseScoped({ body: 'warehouseId' })`. DTO: `warehouseId:string`, `productId:string`, `quantity:@IsInt` (أي إشارة، يقبل 0)، `movementType ∈ {receipt,dispatch,adjustment,transfer_in,transfer_out,return}`، `unitCostBase?`, `reasonCode?`. (VERIFIED)
2. إن كان `receipt` ⇒ `recordManualReceipt` (تكلفة صريحة موجبة + سبب مضبوط + تحقق قبل أي كتابة D3-B). غير ذلك ⇒ `InventoryService.recordMovement(warehouseId, productId, quantity, movementType, null, null, userId, manager, unitCostBase)`. (VERIFIED)
3. **Service** `inventory.service.ts:206-`: يحفظ صف `stock_movements` ويكتب سجل تدقيق، ثم (للأنواع ذات `glKind`) ينشر حدث `inventory.movement.recorded` إلى outbox في المعاملة نفسها. **لا فحص إشارة، لا فحص رصيد/توفر، لا قفل advisory.** (VERIFIED)
4. **القاعدة**: `stock_movements.quantity INT NOT NULL` بلا CHECK؛ لا trigger في الترحيلات. الرصيد المشتق = `SUM(quantity)`. (VERIFIED على الترحيل المذكور؛ trigger خارجه UNVERIFIED)
5. **الحدث المحاسبي** `inventory-costing-handler.service.ts`: يُنشأ فقط لـ `dispatch`, `adjustment`, `return_in`, والاستلام اليدوي/الافتتاحي. (VERIFIED)
6. **المستهلكون:** الواجهة الأمامية الحالية ونسخها الاحتياطية ونسخة `4-daii-erp` القديمة تستخدم فقط `GET /inventory/movements/:id` (صفحة الطباعة) و`GET reports/movements`. لا استدعاء `POST /inventory/movements` في المستودع ولا في المشاريع الشقيقة (`2-xnexus-platform`, `3-xnexus-qr-mobile`) بحسب بحث نصي. الاستثناء الوحيد: سكربت التحقق `authz-tools/closure-http-verification.js` (السطر 96) يرسل POST بجسم ناقص كمسبار رفض صلاحيات (توقع رفض)، وليس مستهلكًا وظيفيًا. **UNVERIFIED:** عملاء API خارجيون أو سكربتات تشغيل لا نراها؛ اختبارات المشروع لا تستدعي المسار (كل الاختبارات تستدعي `InventoryService.recordMovement` مباشرة لبذر الأرصدة).
7. **الصلاحية:** `inventory.movement.create` (editable) ممنوحة للدور القديم `warehouse_worker` (`BackfillLegacyRolePermissions.ts:75`) وللأدوار المشتقة منه، ولمدير الشركة بالتبعية. نطاق المستودع (`WarehouseScoped`) يحدّ المستودعات المرئية فقط. لا مسار اعتماد. (VERIFIED)
8. **دلالة الحركة الدلالية في قاعدة البيانات:** يمكن التمييز لاحقًا بين حركات هذا المسار وغيرها: `referenceType IS NULL AND referenceId IS NULL` (الاستدعاءات المستندية دائمًا تمرّر `referenceType`). استعلام قراءة مقترح لقياس الاستخدام التاريخي (يُنفَّذ فقط بإذن على قاعدة معتمدة): `SELECT "movementType", count(*), min("createdAt"), max("createdAt"), count(*) FILTER (WHERE quantity<0) FROM stock_movements WHERE "referenceType" IS NULL AND "referenceId" IS NULL GROUP BY 1;` (INFERRED كمعرّف لحركات المسار).

## 2. مصفوفة عقد أنواع الحركة عبر هذا المسار (الوضع الحالي)
| النوع | الكمية المسموحة فعليًا | فحص الرصيد | قفل | التقييم (valuation) | القيد المحاسبي | المصير عند الإساءة (INFERRED من الكود) |
|---|---|---|---|---|---|---|
| `receipt` | موجبة بتكلفة صريحة (D3-B) | — | — | يُغذّي القيمة بالتكلفة المعلنة | Dr مخزون / Cr حساب السبب | محكوم (يتحقق قبل الكتابة) |
| `dispatch` | أي عدد صحيح (سالب أو موجب أو 0) | **لا** | **لا** | `consumeIssueCost(abs(qty))` عند استيعاب الحدث | سالب: Dr COGS / Cr مخزون. **موجب:** Dr مخزون / Cr COGS | رصيد سالب في الدفتر بينما الحدث يُرفض `negative_on_hand` (الحركة باقية)؛ **موجب dispatch يزيد الدفتر وينقص التقييم ويُدين المخزون في GL** ⇒ انحراف ثلاثي (دفتر/تقييم/GL) |
| `adjustment` | أي عدد صحيح | **لا** | **لا** | زيادة: بالمتوسط الحالي؛ نقص: `consumeIssueCost` | Dr/Cr مخزون مقابل حساب فروقات الجرد (الربح/الخسارة) | تسوية بلا اعتماد؛ نقص يتجاوز الرصيد ⇒ حدث مرفوض والحركة باقية |
| `transfer_out` | أي عدد صحيح | **لا** | **لا** | **لا ينقل قيمة** | **لا** | يخفض رصيد المستودع دون نظير ودون نقل تقييم؛ المسار المعتمد `recordTransfer` يزاوج out/in ويحمل التكلفة |
| `transfer_in` | أي عدد صحيح | — | **لا** | **لا** | **لا** | ينشئ رصيدًا في الدفتر بلا مصدر ولا تقييم ولا قيد |
| `return` | أي عدد صحيح | **لا** | **لا** | لا | لا | نوع قديم "لا يُستعمل في أي مكان جديد" بحسب `movement-type.ts` |
- الحدث المرفوض لا يعكس الحركة (INFERRED): الحدث يُعالج بعد التزام معاملة الحركة (outbox)، وتعليق المعالج يذكر أن المعالج الذي يعيد `rejected` لا يتراجع (فقط الاستثناء يتراجع) — فلا مسار يلغي الحركة السابقة. وتصنيف إغلاق الفترة يعدّ `negative_on_hand` استثناءً «EXPECTED_BUSINESS_REJECTION, informational» (`closing-exception-classification.spec.ts`) ⇒ **لا يمنع إغلاق الفترة** بالضرورة (VERIFIED نصًا؛ أثره الفعلي UNVERIFIED).
- المسارات المحكومة المقابلة (VERIFIED): `warehouse-transactions` (issue/transfer/adjustment/count) بقفل المستند + أقفال الأزواج + فحص النقص «nothing was posted» + عملية انتقال حالة (process engine) داخل معاملة واحدة، والتحويل المزاوج مع نقل التقييم، وحجز المخزون بقفل وفحص توفر، والاستلام اليدوي بتكلفة وسبب.

## 3. هل مسار آخر يسمح بالمثل؟
- `POST /inventory/reservations` و`assemble` و`warehouses/:id/items` و`opening-stock/import`: محكومة (حجز بفحص توفر مقفل؛ التجميع بفحص مكونات؛ استيراد الافتتاحي يرفض التكرار). (VERIFIED بقراءة المقاطع المذكورة سابقًا)
- لا مسار عام آخر يستدعي `recordMovement` بقيمة تحددها إشارة المستخدم. (INFERRED من فهرس استدعاءات `recordMovement`)

## 4. التوصية الواحدة (للقرار المستقل — غير منفَّذة)
**إغلاق المسار العام لكل الأنواع عدا `receipt`**، لأن بدائل محكومة موجودة لكل نوع آخر:
- `dispatch` ← يتم عبر شحن/تنفيذ الحجز أو مستند issue؛
- `transfer_*` ← مستند transfer (المزاوج مع نقل التقييم)؛
- `adjustment` ← مستند adjustment/count؛
- `return` ← نوع قديم، وبدائله مسارات المرتجعات.
التنفيذ المقترح عند الاعتماد: يرفض الـ controller الأنواع الأربعة بـ `409/410` برسالة تُحيل إلى المسار المناسب، ويُسجَّل المحاولة في التدقيق؛ `receipt` يبقى كما هو.
**التوافق الخلفي:** لا حركات تاريخية تتغير (دفتر append-only)؛ المستهلك الوحيد المعروف (الواجهة) لا يستعمل المسار؛ أثر على عملاء خارجيين غير معروفين UNVERIFIED ⇒ يُقاس أولًا بالاستعلام الوارد في §1.8 على القواعد المعتمدة (وعلى الإنتاج بإذن مستقل) ويُعلن للمستخدمين.
**بدائل (ليست التوصية):** (ب) إبقاء الأنواع مع تشديد: كمية موجبة فقط + إشارة حسب النوع + قفل زوج (مستودع:منتج) + فحص توفر + شرط اعتماد + نقل التقييم للتحويل — أعلى كلفة ومخاطر انحدار، وتكرار لمنطق موجود في المستندات؛ (ج) رفع الصلاحية لدور إداري فقط — لا يعالج غياب الفحوص.
**الخطوة التالية بعد اعتماد العقد:** صياغة المتوقع لـ T-09 (HTTP) قبل التشغيل: أن كل نوع مرفوض يترك بصمة الجداول ثابتة، و`receipt` يعمل كما هو. لا تنفيذ قبل D-2 (قاعدة معتمدة) وD-11 (قرار الإصلاح).
