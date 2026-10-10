# C. سجل الأدلة والقرارات — Evidence & Decision Register

التصنيف: VERIFIED = دليل مباشر قرأته/قسته في هذه الجلسة أو موثق بدليل قابل للفتح · INFERRED = استنتاج · UNVERIFIED = لا دليل كاف.
المسارات نسبة إلى `release-new/backend/` ما لم يُذكر خلاف ذلك.

## C1. الاختبار الأول
| # | المعلومة | التصنيف | المرجع |
|---|---|---|---|
| 1.1 | لا توجد أي نتائج اختبار سعة (شركات/مستخدمون متزامنون/نقطة تدهور) | VERIFIED (غياب بعد بحث) | بحث في docs وinventory الأدوات؛ `../FINAL_RELEASE_REPORT.md` ~154–157، `../MASTER_PROJECT_STATUS.md` ~318 («load testing … still not done») |
| 1.2 | لا أدوات k6/JMeter/Artillery في المستودع | VERIFIED | `git ls-files` |
| 1.3 | هدف 95% < ثانيتين عند 1,000 مستخدم | UNVERIFIED كمعيار DAII (غير موجود في وثائقنا) | — |
| 1.4 | زمن استجابة مستخدم واحد: p95 9–16ms على 10 endpoints، أسوأ فرق +14% | VERIFIED على بيئة التطوير | `docs/decisions/RELEASE-1.1.6-READINESS-REPORT-2026-10-09.md` §4؛ `docs/decisions/evidence-2026-10-09/benchmark-round3-prepared-statement-FINAL.txt` |
| 1.5 | بيئة القياس: i7-7600U 2C/4T، 15.9GB RAM، Node 20.20.2 | VERIFIED (قياس اليوم) | PowerShell `Get-CimInstance` 2026-10-10 |
| 1.6 | إعدادات PG التفصيلية وقت القياس (max_connections…) | UNVERIFIED | — |
| 1.7 | 6 عمليات تتسابق على تخصيص قاعدة مجمعة → 3 شركات | VERIFIED (اختبار) | `src/foundation/company/company-database-pool.multi-process.real-pg.spec.ts` (مذكور في RELEASE-1.1.6 §2) |
| 1.8 | 40 سجل تدقيق متزامن بسلسلة صحيحة | VERIFIED (اختبار موجود) | `src/foundation/audit/audit-chain-concurrency.real-pg.spec.ts:35` |
| 1.9 | عنق الزجاجة المرجح عند زيادة الشركات هو اتصالات PG/الاستضافة المشتركة | INFERRED | تصميم قاعدة لكل شركة (`COMPANY_DB_MODE`) |
| 1.10 | عدم تسرب البيانات تحت الحمل | UNVERIFIED (العزل الوظيفي VERIFIED في بند 2.5) | — |

## C2. الاختبار الثاني
| # | المعلومة | التصنيف | المرجع |
|---|---|---|---|
| 2.1 | 195 ملف spec؛ 65 company-isolation؛ 23 real-pg؛ 42 تذكر تزامن/تكرار | VERIFIED | عدّ `find`/`grep` 2026-10-10 |
| 2.2 | مستودع غير معروف في PR/PO/SO → 404 دون تعديل | VERIFIED (اختبار) | `src/domains/procurement/interface/warehouse-reference.company-isolation.spec.ts`; commit `92426fe`; `docs/decisions/WAREHOUSE-REFERENCE-INTEGRITY-2026-10-08.md` |
| 2.3 | منع الصرف > المتاح / تعديل الرصيد المباشر | UNVERIFIED (لم يُعثر على اختبار مباشر) | بحث spec |
| 2.4 | منع تكرار/تجاوز مراحل الشحن؛ ملكية المخزون؛ الحجز مرتين | INFERRED من التصميم | `docs/decisions/ADR-009-…md`, `ADR-007-…md`, `D4-RETURNS-ACCOUNTING-POLICY-2026-10-05.md` |
| 2.5 | عزل الشركات والصلاحيات على API: A→B/B→A مرفوض، بصمات قبل/بعد، 404 | VERIFIED على بيئة العزل | `docs/decisions/AUTHORIZATION-FOUNDATION-FINAL-CLOSURE-REPORT-2026-10-08.md` §4؛ `docs/decisions/authz-tools/security-mutation-verification.js` |
| 2.6 | `closure-http-verification` 23/23 | VERIFIED (تقرير) | نفس التقرير §4.2b |
| 2.7 | revocation فوري: ALL PASS | VERIFIED | `docs/decisions/evidence-2026-10-09/revocation-immediacy-result.txt` |
| 2.8 | ثغرة تجاوز نطاق تصدير المخزون اكتُشفت وأُصلحت | VERIFIED | `RELEASE-1.1.6-READINESS-REPORT-2026-10-09.md` §1 |
| 2.9 | نتيجة سابقة security/mutation 40/41 | VERIFIED كاقتباس وثائقي؛ التفصيل غير مفحوص هنا | `docs/decisions/COMPANY-DATABASE-ALLOCATION-AND-1.1.6-READINESS-2026-10-09.md:73` |
| 2.10 | التحقق على الاستضافة الفعلية لهذه الاختبارات | UNVERIFIED | — |
| 2.11 | سلسلة التدقيق في الإنتاج مكسورة عند seq 1 | OPEN — السبب UNVERIFIED | `RELEASE-1.1.6-READINESS-REPORT-2026-10-09.md` §1/§6 |
| 2.12 | منع حذف/تعديل الحركات المسجلة دون مسار تصحيح؛ تطابق الأرصدة مع الحركات | UNVERIFIED كسيناريوهات (توجد reconciliation GRNI/WIP) | `src/domains/accounting/application/{grni,wip}-reconciliation.spec.ts` |
| 2.13 | تزامن: deadlock retry، ترقيم القيود، تخصيص القواعد | VERIFIED وجود اختبارات | `f03-deadlock-retry-verification.spec.ts`, `journal-numbering.company-isolation.spec.ts` |
| 2.14 | تزامن صرف المخزون/التحصيل المزدوج | UNVERIFIED | — |
| 2.15 | الانحدار الكامل المتسلسل 194/195 على الشجرة الموحدة | VERIFIED (نتيجة مسجلة في الجلسة، سجل الجلسة 2026-10-10) | `RELEASE-1.1.9-ADDENDUM-2026-10-10.md`; لا يُحتسب إغلاقًا للاختبار 2 |
| 2.16 | الاختبار المتوازي يتعارض على قاعدة مشتركة | VERIFIED (لوحظ وفُسِّر) | سجلات الجلسة |

## C3. الاختبار الثالث
| # | المعلومة | التصنيف | المرجع |
|---|---|---|---|
| 3.1 | تعريف «الاختبار الثالث» | **غير محسوم** | بحث docs + سجلات جلسات: لا تعريف |
| 3.2 | «Phase 9 Security Verification»، «Phase 10 Load Testing» كمراحل مستقبلية في خطة Multi-Tenant | VERIFIED وجودها كنص | سجل جلسة 2026-09-22 (طلب مراجعة Multi-Company §13) — ليست تعريفًا للاختبار الثالث |
| 3.3 | P6: Cross-Company adversarial matrix (V-32)، on-prem regression | VERIFIED نص | `docs/decisions/saas-control-plane/WP-1.2-VERIFICATION-AND-ACCEPTANCE-PLAN.md:54,95` — مرشح محتمل فقط، غير معتمد كتعريف |

## C4. سجل القرارات المطلوبة (مفتوحة)
| # | القرار | المالك |
|---|---|---|
| D-1 | تعريف الاختبار الثالث ومصدره | المراجع/CTO |
| D-2 | البيئة المعتمدة للاختبارين ومواصفات المضيف المستهدف | CTO |
| D-3 | معايير قبول الاختبار 1 (زمن، أخطاء، موارد، أحجام) | CTO |
| D-4 | الإذن بتنزيل أداة حمل (k6 أو بديل) | المستخدم |
| D-5 | سياسة Throttler أثناء الحمل | CTO |
| D-6 | اعتماد قالب سيناريو الاختبار 2 وترتيب المحاور | CTO |
| D-7 | هل تُحتسب الاختبارات القائمة أدلة جزئية بعد مراجعتها بالتفصيل | CTO |
