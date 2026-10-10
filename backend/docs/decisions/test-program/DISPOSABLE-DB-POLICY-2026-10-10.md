# سياسة القواعد المؤقتة — فصل الإداري عن الأعمال، وملف الاعتماد النهائي للمراجعة · 2026-10-10

الحالة: **جاهزة للمراجعة. القاعدة غير معتمدة.** القائمة المعتمدة في `approved-test-databases.json` ما زالت فارغة (`"approved": []`)؛ لا اتصال بالمنفذ 5544 من أي اختبار أعمال، ولم تُنفَّذ T-01…T-12. المرجع: قرار CTO «PHASE 6 DATABASE APPROVAL GATE» + `T-PLAN-AMENDMENTS.md` (A-1).

## 1. ما تغيّر في الحارس (commit يلي هذه الوثيقة)
| البند | السلوك الجديد |
|---|---|
| دور الاتصال | كل اتصال يُصنَّف: **admin** (قاعدة في `adminDatabases`، هنا `postgres`) أو **business** (قاعدة تطابق `databasePatterns` أو مُسمّاة في `databases`) أو **مرفوض** |
| `postgres` كهدف اختبار أعمال | **مرفوض**: لا يصلح هدفًا للإعداد المحيط (`preflight` → «administrative database»)، ولا تُنفَّذ عليه عبارات أعمال (انظر التالي) |
| ما يُسمح على اتصال admin | فقط: تحكم المعاملة (`BEGIN/COMMIT/ROLLBACK`)، `SET` للجلسة، `SELECT`/`SHOW` للقراءة (بلا `INTO` ولا تعديل)، و**بالنص** `CREATE DATABASE "<اسم>"` و`DROP DATABASE [IF EXISTS] "<اسم>" [WITH (FORCE)]` حيث الاسم يطابق `^daii_test_biz_t[0-9]{2}[a-z0-9_]*$`. أي بند آخر (`TEMPLATE`، `OWNER`، `ENCODING`، `CASCADE`، `ALTER DATABASE`…) أو أي INSERT/UPDATE/DELETE/DDL/COPY/GRANT/دور/ALTER SYSTEM ⇒ مرفوض قبل الإرسال |
| الأسماء المحجوبة صلبًا (لا يُلغيها إدخال) | `daii_dev` وأي اسم يحويه (يشمل `restore_old_daii_dev` و`restore_quiet_daii_dev`)، `daii`، أي اسم فيه prod/production/live/staging، أي اسم فيه `ambient` (يشمل `daii_test_ambient` والاثنتين الأخريين)، أي اسم يبدأ بـ `restore_`، وقواعد النظام `postgres`/`template0`/`template1` كأهداف أعمال، والمنفذ 5433، وأي مضيف غير loopback |
| الأدوار | `rolePatterns: []` ⇒ أي `CREATE/ALTER/DROP ROLE|USER` مرفوض على كل الاتصالات |
| اعتماد وهمي | `approvedBy` يجب أن يكون اسمًا حقيقيًا (لا `<CTO name>` ولا TBD) و`approvedOn` تاريخًا صالحًا `YYYY-MM-DD`؛ وإلا يُتجاهل الإدخال كاملًا |
| الاسم يُقرأ كما هو | لا قصّ (trim) للاسم: `"daii_test_biz_t01 "` لا يُعامَل كـ `daii_test_biz_t01` |

## 2. أدلة (نُفِّذت بلا قاعدة بيانات، Client وهمي)
`npm run test:db-guard` ⇒ **44/44**:
- `db-guard.test.js` 11 · `db-guard-process.test.js` 9 · `db-guard-statements.test.js` 8 · **`db-guard-admin.test.js` 9 (جديد)** · `db-guard.coverage.test.js` 4 · **`biz-evidence.test.js` 3 (جديد)**.
- ما تثبته `db-guard-admin.test.js`: (1) الإدخال المقترح غير مكتمل كما سُلِّم ولا يُحتسب موافقة، ويُقبل فقط بعد ملء الاسم والتاريخ؛ (2) أهداف الأعمال: `t01…` فقط، ومرفوض كل من `postgres` و`template*` و`daii_test_ambient` (الثلاث) و`daii_dev` و`restore_old_daii_dev` و`restore_quiet_daii_dev` و`restore_company_*` و`pool_*` و`rehearsal_*` و`company_*` وأسماء قريبة (`t1`, `T01`, `t01-x`, فراغ في آخر الاسم…)؛ (3) على اتصال `postgres` يُسمح بإنشاء/حذف الأسماء المؤقتة الثلاثة لكل `t01…t12` فقط؛ (4) كل عمل أعمال على `postgres` مرفوض (قائمة أكثر من 20 عبارة: INSERT/UPDATE/DELETE/TRUNCATE/DDL/COPY/GRANT/DO/SELECT INTO/CTE معدِّل/أدوار/ALTER SYSTEM…)، وكل بنود CREATE DATABASE الإضافية (TEMPLATE/OWNER/ENCODING) مرفوضة؛ (5) إنشاء/حذف أي اسم غير مطابق مرفوض (ambient، restore، dev، نظام، قريب)، بما فيه عبارة ثانية داخل دفعة؛ (6) لا أدوار؛ (7) الحارس مثبَّت على `pg.Client` وهمي: العبارات المرفوضة **لا تصل إلى السائق** والمسموح وحده يصله؛ (8) **منع الانجراف:** يقرأ مصدر الـ harness الحالي (`two-company-real-pg-harness.ts`) ويؤكد أن عبارات الإدارة فيه هي بالضبط الثلاث المسموحة، وأن أسماء قواعده `daii_test_<prefix>_{control_plane,company_a,company_b}`؛ ثم يتحقق أن الأسماء لكل `biz_t01…biz_t12` مسموحة وأن بادئات الاختبارات الأخرى (`wh_txn_isolation`, `nav02_policy`…) مرفوضة. أي تغيير في عبارات الـ harness يُفشل الاختبار.
- من الحزمة السابقة ما زال سليمًا: جسم الاتصال، `pg.native`، libpq CLI، عمليات Node، `bv-*.ts`، تغطية الأدوات (أداة جديدة غير مصنَّفة تُفشل الاختبار).
- المجسّ داخل jest: `npm run test:db-guard:jest-probe` 7/7 (سبق، وسيُعاد مع الحزمة النهائية).

## 3. التحقق من «قاعدة جديدة لكل تشغيل، من مجموعة الترحيلات الحالية، وتنظيف الاسم المحدد فقط»
- **ثابت (نُفِّذ):** قراءة الـ harness: يُنفّذ `DROP DATABASE IF EXISTS` ثم `CREATE DATABASE` للأسماء الثلاثة ثم `runMigrationsForDatabase(APP_ROOT, …, ['core'|…])` من شجرة `src/database/migrations` الحالية؛ و`teardown` يحذف الأسماء ذاتها بـ `WITH (FORCE)`. اختبار منع الانجراف أعلاه يمنع تغيّر هذا السلوك دون إعادة مراجعة.
- **تشغيلي (مُجهَّز وغير مشغَّل — يتطلب إدخال الاعتماد):** `src/foundation/testing/biz-harness-smoke.biz.real-pg.spec.ts` (T-00، يُشغَّل أولًا): يقرأ `system_identifier` ويقارنه بقيمة الإدخال (STOP عند الاختلاف)، ويثبت أن القواعد الثلاث غير موجودة قبل التشغيل، ثم بعد الإنشاء أن الترحيلات المطبَّقة = ملفات المستودع للـ tags المستخدمة (مجموعة الطوابع الزمنية متساوية في control plane وشركتي A/B)، ثم يكتب الأدلة **ويتحقق منها بإعادة القراءة قبل أي تنظيف**، ثم يحذف القواعد الثلاث، ثم يتحقق أن مجموعة القواعد الأخرى (الأسماء والـ oid) **مطابقة تمامًا** لما قبل التشغيل. فحص النوع `tsc --noEmit` للملف نظيف (الخطأ الوحيد في المشروع قديم وغير متصل: `_deploy/staging/bootstrap-v1.0.3/...`).
- **الأدلة:** `tools/testing/biz-evidence.js` — كل ما يُكتب داخل `backend/docs/decisions/evidence-2026-10-10-biz/<T-id>/<runId>/` فقط (يرفض أي مسار خارجه)، ترويسة تثبّت commit والفرع والمسارات المتسخة وإصدار التطبيق وnode والبيئة (دون أي كلمة سر)، `MANIFEST.sha256` يُعاد التحقق منه، وتصنيف النتائج PASS/FAIL/FAIL-DEFECT/BLOCKED/STOP.

## 4. الفرق النهائي المقترح للاعتماد (لم يُطبَّق)
الملف: `backend/tools/testing/approved-test-databases.json`
```diff
-  "approved": [],
+  "approved": [
+    {
+      "id": "isolated-5544-biz",
+      "host": "127.0.0.1",
+      "port": 5544,
+      "adminDatabases": ["postgres"],
+      "databases": [],
+      "databasePatterns": ["^daii_test_biz_t[0-9]{2}[a-z0-9_]*$"],
+      "rolePatterns": [],
+      "approvedBy": "<اسم المعتمد>",
+      "approvedOn": "<YYYY-MM-DD>",
+      "identityEvidence": "D2-IDENTITY-EVIDENCE-2026-10-10.md + evidence-2026-10-10-d2/* (system_identifier 7692905965783805068; data dir D:/DAII-ISOLATED-PG/data; listen 127.0.0.1; pg_hba scram loopback; PostgreSQL 18.6)",
+      "expectedSystemIdentifier": "7692905965783805068"
+    }
+  ],
```
(النسخة القابلة للتحقق: `APPROVAL-ENTRY-PROPOSED.json`؛ والإدخال لا يُحتسب موافقة قبل ملء الاسم والتاريخ.)
**ما يتيحه الإدخال:** اتصال admin بـ `postgres` على 127.0.0.1:5544 لإنشاء/حذف قواعد أسماؤها تطابق النمط فقط وقراءة الكتالوج؛ واتصالات أعمال بتلك القواعد فقط. **ما لا يتيحه:** أي عمل أعمال على `postgres`؛ أي وصول إلى `daii_test_ambient` أو `restore_*` أو `daii_dev` أو أي قاعدة أخرى؛ أي دور؛ 5433/5656؛ الاستضافة.

## 5. بعد الاعتماد (تلقائي)
1) `T-00` (smoke) ⇒ 2) T-01…T-04 ⇒ T-05…T-08 ⇒ T-09 (حسب العقد المجمَّد، دون تعديل كود المنتج) ⇒ T-11…T-12 ⇒ T-10. كل اختبار يُكتب ويُشغَّل في الخطوة نفسها، والأدلة تُحفظ قبل التنظيف، والإصلاح داخل التفويض فقط (F-INV-001 يبقى تفويضًا منفصلًا).
