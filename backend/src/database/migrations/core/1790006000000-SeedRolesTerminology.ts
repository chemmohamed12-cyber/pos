import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F3 (2026-10-07): the sidebar label of the Company Roles screen and the display titles of the role templates added for the modules that
 * had none (procurement, payroll, attendance, commission, targets, treasury officer). Idempotent upsert.
 */
export class SeedRolesTerminology1790006000000 implements MigrationInterface {
  name = 'SeedRolesTerminology1790006000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.company_roles', 'nav', 'أدوار الشركة', 'Company roles'],
    ['role.procurement.manager', 'role_label', 'مدير المشتريات', 'Procurement Manager'],
    ['role.procurement.buyer', 'role_label', 'موظف مشتريات', 'Buyer'],
    ['role.procurement.viewer', 'role_label', 'مطّلع على المشتريات', 'Procurement Viewer'],
    ['role.payroll.manager', 'role_label', 'مدير الرواتب', 'Payroll Manager'],
    ['role.payroll.viewer', 'role_label', 'مطّلع على الرواتب', 'Payroll Viewer'],
    ['role.attendance.manager', 'role_label', 'مدير الحضور', 'Attendance Manager'],
    ['role.attendance.viewer', 'role_label', 'مطّلع على الحضور', 'Attendance Viewer'],
    ['role.commission.manager', 'role_label', 'مدير العمولات', 'Commission Manager'],
    ['role.commission.viewer', 'role_label', 'مطّلع على العمولات', 'Commission Viewer'],
    ['role.targets.manager', 'role_label', 'مدير المستهدفات', 'Targets Manager'],
    ['role.targets.viewer', 'role_label', 'مطّلع على المستهدفات', 'Targets Viewer'],
    ['role.finance.treasury_officer', 'role_label', 'مسؤول الخزينة', 'Treasury Officer'],
    // The 20 pre-F3 template titles had no terminology entry (the code was referenced by `/auth/me` but never seeded): closed here.
    ['role.sales.manager', 'role_label', 'مدير المبيعات', 'Sales Manager'],
    ['role.sales.rep', 'role_label', 'مندوب مبيعات', 'Sales Representative'],
    ['role.sales.viewer', 'role_label', 'مطّلع على المبيعات', 'Sales Viewer'],
    ['role.inventory.manager', 'role_label', 'مدير المخازن', 'Inventory Manager'],
    ['role.inventory.operator', 'role_label', 'مشغّل مخازن', 'Inventory Operator'],
    ['role.inventory.viewer', 'role_label', 'مطّلع على المخازن', 'Inventory Viewer'],
    ['role.logistics.manager', 'role_label', 'مدير الشحن', 'Logistics Manager'],
    ['role.logistics.dispatcher', 'role_label', 'مسؤول توزيع', 'Dispatcher'],
    ['role.logistics.viewer', 'role_label', 'مطّلع على الشحن', 'Logistics Viewer'],
    ['role.finance.manager', 'role_label', 'مدير الخزينة والمالية', 'Finance Manager'],
    ['role.finance.clerk', 'role_label', 'موظف مالي', 'Finance Clerk'],
    ['role.finance.viewer', 'role_label', 'مطّلع على الخزينة', 'Finance Viewer'],
    ['role.reporting.analyst', 'role_label', 'محلل تقارير', 'Reporting Analyst'],
    ['role.hr.manager', 'role_label', 'مدير الموارد البشرية', 'HR Manager'],
    ['role.hr.viewer', 'role_label', 'مطّلع على الموارد البشرية', 'HR Viewer'],
    ['role.manufacturing.manager', 'role_label', 'مدير التصنيع', 'Manufacturing Manager'],
    ['role.manufacturing.operator', 'role_label', 'مشغّل تصنيع', 'Manufacturing Operator'],
    ['role.manufacturing.viewer', 'role_label', 'مطّلع على التصنيع', 'Manufacturing Viewer'],
    ['role.accounting.manager', 'role_label', 'مدير المحاسبة', 'Accounting Manager'],
    ['role.accounting.viewer', 'role_label', 'مطّلع على المحاسبة', 'Accounting Viewer'],
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
