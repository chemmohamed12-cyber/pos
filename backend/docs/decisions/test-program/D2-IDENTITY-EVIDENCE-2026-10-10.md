# D-2 — إثبات هوية قواعد الاختبار المحلية (قراءة فقط) · 2026-10-10

التفويض: قرار CTO 2026-10-10 (موافقة مشروطة). النطاق المنفَّذ: المنفذان 5544 و5656 فقط. **لا كتابة، لا إنشاء/حذف قواعد، لا ترحيلات، لا اختبارات أعمال، لا استضافة.** لا أُعتمد أي قاعدة هنا؛ القرار بعد مراجعتكم لكل قاعدة على حدة.
الأدلة الخام (خارج أي قاعدة): `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\_test-evidence\2026-10-10-d2\port-5544-identity.json` (+ `.sha256`). الاستعلامات: SELECT/SHOW فقط داخل `BEGIN READ ONLY` على قاعدة الصيانة `postgres`، مع `default_transaction_read_only=on`. بيانات الدخول من أدوات المشروع الاختبارية ولم تُسجَّل في الأدلة.

## 1. المنفذ 5656
- **VERIFIED:** لا أحد يستمع على 5656 (فحص مآخذ الشبكة المحلية). لم يُشغَّل أي خادم، ولم تُحاول أي محاولة اتصال.
- **UNVERIFIED:** هل توجد مجموعة بيانات (cluster) لـ 5656 أصلًا؛ وما قواعدها؛ هل هي معزولة. لا يمكن اعتماده ولا رفضه بالأدلة.
- **أثر:** سكربتات `authz-tools` و`bv-*.ts` المبنية على 5656 (`bv_cp`, `bv_co`, `d3verify_main`) لا تعمل الآن. توصية (للقرار): إسقاط 5656 من قائمة المقترحات، وإن لزم يُعاد إنشاء بيئة `bv_*` على النسخة المعتمدة (5544) بعد اعتمادها.

## 2. المنفذ 5544 — الحقائق
| البند | القيمة | التصنيف |
|---|---|---|
| الإصدار | PostgreSQL 18.6 (x86_64-windows, msvc-19.44) | VERIFIED (SELECT version()) |
| عملية الخادم | pid 15696، `C:/Program Files/PostgreSQL/18/bin/postgres.exe`، بدأت 2026-10-10 02:01 المحلي | VERIFIED (Win32_Process + pg_postmaster_start_time) |
| سطر التشغيل | `-D D:/DAII-ISOLATED-PG/data -p 5544 -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=300` | VERIFIED |
| دليل البيانات | `D:/DAII-ISOLATED-PG/data` (من pg_settings أيضًا) | VERIFIED |
| system_identifier | `7692905965783805068` | VERIFIED (pg_control_system) |
| الاستماع | `listen_addresses=127.0.0.1`، المقبس مرتبط بـ 127.0.0.1 فقط، لا unix sockets | VERIFIED |
| المصادقة (pg_hba) | قواعد `local` و`host 127.0.0.1/32` و`host ::1/128` كلها `scram-sha-256`؛ لا قاعدة لعناوين خارجية | VERIFIED (pg_hba_file_rules) |
| SSL / archive | `ssl=off`, `archive_mode=off`, `wal_level=replica` | VERIFIED |
| المتانة | `fsync=off` (عمدًا للاختبار؛ فقد البيانات عند انهيار النظام مقبول) | VERIFIED |
| الأدوار | `isolated_admin` (superuser، replication)، `daii` (login، createdb، غير superuser)، `daii_nocreate_663466` | VERIFIED |
| الجلسات وقت الفحص | لا جلسة عميل غير جلستي (لا عملية أخرى تستخدمه لحظتها) | VERIFIED لحظة واحدة؛ الاستمرارية INFERRED |
| عدد القواعد | 19 (3 قوالب/النظام + 16 غير قالب) | VERIFIED |
| الحجم الكلي للقواعد | ~1077 MB | VERIFIED |

القواعد غير القالبية: `postgres`، `daii_test_ambient`، `daii_test_fanout_ambient`، `daii_test_h3_ambient`، `pool_b_663466`، `pool_dirty_663466`، `pool_one_663466`، `pool_r1_663466`، `rehearsal_fresh`، `company_dabcc38172364032a8ed31a537c29027`، خمس قواعد `restore_company_*`، **`restore_old_daii_dev`** و**`restore_quiet_daii_dev`** (مالكهما الدور `daii`).

## 3. التقييم: هل هي تجريبية ومعزولة وغير مشتركة؟
- **معزولة عن الشبكة (VERIFIED):** مرتبطة بـ loopback فقط، ومصادقة scram، ولا قاعدة hba لغير loopback.
- **ليست الخادم المشترك (VERIFIED على مستوى الخادم):** عملية مستقلة (pid 15696) بدليل بيانات مختلف (`D:/DAII-ISOLATED-PG/data`) ومنفذ مختلف عن الخادم المشترك الذي يستمع على 5433 (pid 7008). **لم أتصل بـ 5433** ولذلك لا أقارن system_identifier معه (UNVERIFIED كمقارنة، لكن عمليتين وبيانات منفصلتين تكفي لإثبات الانفصال).
- **غير مستخدمة من عملية أخرى لحظة الفحص (VERIFIED لحظة، INFERRED بعدها).**
- **تحذيران (INFERRED، يحتاجان قرارًا لا فحصًا إضافيًا الآن):**
  1. توجد قاعدتان `restore_old_daii_dev` و`restore_quiet_daii_dev` يبدو أنهما نسختا استعادة من `daii_dev`. **لم أفتحهما** (قيد القراءة التعريفية فقط)، فمحتواهما غير معروف وقد يحتويان بيانات تطوير حقيقية الشكل. اسماهما لا يطابقان الرفض المطلق (`daii_dev` بالضبط) لأنهما `restore_*_daii_dev`. توصية: **لا تدخلا في أي نمط معتمد**، ويقرر CTO هل تُحفظان أم تُنظفان لاحقًا بقرار مستقل.
  2. وجود الدور `daii` (دور التطوير) على هذه الدفعة يعني أن بيانات/أدوار من التطوير نُسخت إليها يومًا؛ يلزم ألا تُستخدم بيانات اعتماد التطوير مع هذه النسخة.
- **ملاحظة خارجية (VERIFIED بفحص المآخذ، خارج النطاق):** الخادم المشترك 5433 يستمع على `0.0.0.0` و`::` (كل الواجهات). لم أتصل به. أرفعها كملاحظة مخاطر للمراجعة، لا كجزء من القرار.

## 4. ما يتعذر إثباته
| البند | السبب |
|---|---|
| حجم كل قاعدة على حدة، ومحتواها، وصلاحية كل قاعدة للاختبار | استعلام الأحجام لكل القواعد تجاوز مهلة الاستعلام (15 ثانية)؛ ولم أتصل بقاعدة غير `postgres` (حدود القراءة) |
| أن `daii_test_ambient` فارغة/نظيفة | لم تُفتح |
| تاريخ إنشاء كل قاعدة | لا يوجد عمود تاريخ في الكتالوج؛ يلزم نظام الملفات |
| هوية 5656 | لا يعمل |

## 5. اقتراح للقرار (غير معتمد)
إدخال في `approved-test-databases.json` بعد قراركم (لا أُضيفه أنا):
```
host 127.0.0.1 · port 5544 · identityEvidence: D2-IDENTITY-EVIDENCE-2026-10-10 (system_identifier 7692905965783805068, data dir D:/DAII-ISOLATED-PG/data)
databases: postgres, daii_test_ambient, daii_test_fanout_ambient, daii_test_h3_ambient
databasePatterns (يحدّدها CTO بعد مراجعة أسماء ما تنشئه الاختبارات): مثال ^daii_test_, ^pool_, ^restore_company_, ^company_[0-9a-f]{32}$, ^rehearsal_
```
أسماء ما تنشئه الاختبارات غير موحدة (`pool_*`, `restore_company_*`, `rehearsal_*`, `company_<hex>`, `daii_test_*`…) فنمط واحد لا يكفي. أستبعد صراحة `restore_*_daii_dev`.
قبل الاعتماد أقترح: (1) قرار بشأن القاعدتين `restore_*_daii_dev`؛ (2) قرار بشأن 5656؛ (3) إن شئتم، فحص قراءة إضافي مقيد لحجم/محتوى قاعدة بعينها (طلب مستقل).
