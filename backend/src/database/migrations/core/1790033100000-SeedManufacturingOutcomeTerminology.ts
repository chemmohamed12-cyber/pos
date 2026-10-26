import { MigrationInterface, QueryRunner } from 'typeorm';
import { seedTerminologyOwned, unseedTerminologyOwned } from '../../seed-helpers/terminology-ownership';

/** Manufacturing Engine S1 (2026-10-24) - movement-type labels for scrap / recovery. Data only; ON CONFLICT DO NOTHING; `down` removes exactly these rows. */
export class SeedManufacturingOutcomeTerminology1790033100000 implements MigrationInterface {
  name = 'SeedManufacturingOutcomeTerminology1790033100000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['movement_type.work_order_scrap', 'movement_type', 'هالك أمر تشغيل', 'Work order scrap'],
    ['movement_type.work_order_recovery', 'movement_type', 'استرداد خامة من هالك', 'Work order material recovery'],
    ['nav.manufacturing_processes', 'field', 'تعريفات العمليات', 'Process definitions'],
    ['policy.manufacturing_scrap_loss_account_code.label', 'field', 'حساب خسارة هالك التصنيع', 'Manufacturing scrap loss account'],
    ['policy.manufacturing_scrap_loss_account_code.help', 'panel', 'الطرف المدين عند تسجيل هالك أمر تشغيل (دائن: الإنتاج تحت التشغيل). عادةً حساب مصروف.', 'Debit side when work-order scrap is recognised (credit: WIP). Typically an expense account.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await seedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows, 'preserve');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await unseedTerminologyOwned(queryRunner, 'manufacturing', this.name, this.rows);
  }
}
