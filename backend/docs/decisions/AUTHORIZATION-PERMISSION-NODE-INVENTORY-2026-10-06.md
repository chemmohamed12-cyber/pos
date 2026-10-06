# Permission node inventory — evidence appendix (2026-10-06)

Generated read-only from the source by scanning every `*.controller.ts` for `@RequirePermission(node, access)`. **No code was changed.** The constants `COMPANY_*_NODE` resolve to `core.company.members.manage`, `core.company.backup.manage` and `core.company.audit.view`.

## COMPANY_AUDIT_VIEW_NODE (1)

| Node | Access level required | Routes |
|---|---|---|
| `COMPANY_AUDIT_VIEW_NODE` | read-only | 1 |

## COMPANY_BACKUP_MANAGE_NODE (1)

| Node | Access level required | Routes |
|---|---|---|
| `COMPANY_BACKUP_MANAGE_NODE` | editable | 1 |

## COMPANY_MEMBERS_MANAGE_NODE (1)

| Node | Access level required | Routes |
|---|---|---|
| `COMPANY_MEMBERS_MANAGE_NODE` | editable | 1 |

## accounting (63)

| Node | Access level required | Routes |
|---|---|---|
| `accounting.account.assign` | editable | 1 |
| `accounting.account.create` | editable | 2 |
| `accounting.account.edit` | editable | 5 |
| `accounting.account.view` | read-only | 6 |
| `accounting.ap.adjust` | editable | 1 |
| `accounting.ap.approve` | editable | 1 |
| `accounting.ap.create` | editable | 2 |
| `accounting.ap.view` | read-only | 3 |
| `accounting.ar.adjust` | editable | 1 |
| `accounting.ar.approve` | editable | 1 |
| `accounting.ar.create` | editable | 2 |
| `accounting.ar.view` | read-only | 3 |
| `accounting.cash.adjust` | editable | 1 |
| `accounting.cash.approve` | editable | 1 |
| `accounting.cash.create` | editable | 2 |
| `accounting.cash.view` | read-only | 4 |
| `accounting.closing_exception.annotate_test_artifact` | editable | 1 |
| `accounting.closing_exception.resolve` | editable | 1 |
| `accounting.closing_exception.view` | read-only | 1 |
| `accounting.closing_snapshot.verify` | read-only | 1 |
| `accounting.closing_snapshot.view` | read-only | 1 |
| `accounting.currency.create` | editable | 1 |
| `accounting.currency.edit` | editable | 2 |
| `accounting.currency.view` | read-only | 1 |
| `accounting.dimension.create` | editable | 2 |
| `accounting.dimension.edit` | editable | 4 |
| `accounting.dimension.view` | read-only | 2 |
| `accounting.exchange_rate.create` | editable | 1 |
| `accounting.exchange_rate.view` | read-only | 1 |
| `accounting.financial_event.view` | read-only | 2 |
| `accounting.fiscal_period.edit` | editable | 2 |
| `accounting.fiscal_period.reopen` | editable | 1 |
| `accounting.fiscal_period.view` | read-only | 3 |
| `accounting.fiscal_year.create` | editable | 3 |
| `accounting.fiscal_year.view` | read-only | 2 |
| `accounting.fixed_asset.adjust` | editable | 1 |
| `accounting.fixed_asset.approve` | editable | 1 |
| `accounting.fixed_asset.create` | editable | 1 |
| `accounting.fixed_asset.edit` | editable | 3 |
| `accounting.fixed_asset.post` | editable | 1 |
| `accounting.fixed_asset.view` | read-only | 7 |
| `accounting.grni.create` | editable | 2 |
| `accounting.grni.view` | read-only | 2 |
| `accounting.inventory.adjust` | editable | 1 |
| `accounting.inventory.approve` | editable | 1 |
| `accounting.inventory.create` | editable | 2 |
| `accounting.inventory.view` | read-only | 2 |
| `accounting.journal.create` | editable | 1 |
| `accounting.journal.edit` | editable | 1 |
| `accounting.journal.post` | editable | 2 |
| `accounting.journal.reverse` | editable | 1 |
| `accounting.journal.submit` | editable | 1 |
| `accounting.journal.view` | read-only | 2 |
| `accounting.ledger.view` | read-only | 3 |
| `accounting.report.export` | read-only | 3 |
| `accounting.report.view` | read-only | 4 |
| `accounting.tax_code.create` | editable | 1 |
| `accounting.tax_code.edit` | editable | 1 |
| `accounting.tax_code.view` | read-only | 1 |
| `accounting.tax_period.create` | editable | 1 |
| `accounting.tax_period.view` | read-only | 1 |
| `accounting.wip.create` | editable | 2 |
| `accounting.wip.view` | read-only | 2 |

## attendance (14)

| Node | Access level required | Routes |
|---|---|---|
| `attendance.approval.approve` | editable | 1 |
| `attendance.approval.create` | editable | 1 |
| `attendance.approval.view` | read-only | 1 |
| `attendance.connector.create` | editable | 1 |
| `attendance.connector.view` | read-only | 1 |
| `attendance.correction.create` | editable | 1 |
| `attendance.day.view` | read-only | 2 |
| `attendance.import.create` | editable | 4 |
| `attendance.import.view` | read-only | 3 |
| `attendance.manual_entry.create` | editable | 1 |
| `attendance.mapping.create` | editable | 1 |
| `attendance.mapping.edit` | editable | 1 |
| `attendance.mapping.view` | read-only | 1 |
| `attendance.raw_record.view` | read-only | 2 |

## commission (6)

| Node | Access level required | Routes |
|---|---|---|
| `commission.adjustment.create` | editable | 1 |
| `commission.batch.approve` | editable | 1 |
| `commission.batch.submit` | editable, read-only | 2 |
| `commission.policy.create` | editable | 1 |
| `commission.policy.view` | read-only | 2 |
| `commission.result.view` | read-only | 3 |

## core (8)

| Node | Access level required | Routes |
|---|---|---|
| `core.approval.manage` | editable | 2 |
| `core.approval.view` | read-only | 6 |
| `core.config.edit` | editable | 2 |
| `core.config.view` | read-only | 2 |
| `core.entitlement.apply` | editable | 1 |
| `core.entitlement.view` | read-only | 1 |
| `core.limit.edit` | editable | 2 |
| `core.limit.view` | read-only | 2 |

## finance (4)

| Node | Access level required | Routes |
|---|---|---|
| `finance` | editable | 12 |
| `finance.invoice.cancel` | editable | 1 |
| `finance.invoice.post` | editable | 1 |
| `finance.payment.create` | editable | 3 |

## hr (11)

| Node | Access level required | Routes |
|---|---|---|
| `hr.department.create` | editable | 1 |
| `hr.department.edit` | editable | 1 |
| `hr.department.view` | read-only | 1 |
| `hr.employee.create` | editable | 1 |
| `hr.employee.edit` | editable | 3 |
| `hr.employee.link_user` | editable | 1 |
| `hr.employee.terminate` | editable | 1 |
| `hr.employee.view` | read-only | 3 |
| `hr.leave_request.approve` | editable | 1 |
| `hr.leave_request.create` | editable | 2 |
| `hr.leave_request.view` | read-only | 1 |

## inventory (11)

| Node | Access level required | Routes |
|---|---|---|
| `inventory.assembly.create` | editable | 1 |
| `inventory.movement.create` | editable | 2 |
| `inventory.movement.view` | read-only | 1 |
| `inventory.reservation.create` | editable | 1 |
| `inventory.reservation.release` | editable | 1 |
| `inventory.stock_count.adjust` | editable | 1 |
| `inventory.stock_count.create` | editable | 1 |
| `inventory.transaction.create` | editable | 1 |
| `inventory.valuation.view` | read-only | 1 |
| `inventory.warehouse.create` | editable | 2 |
| `inventory.warehouse.edit` | editable | 3 |

## logistics (13)

| Node | Access level required | Routes |
|---|---|---|
| `logistics.carrier.create` | editable | 1 |
| `logistics.carrier.edit` | editable | 3 |
| `logistics.collection.post` | editable | 1 |
| `logistics.collection.view` | read-only | 2 |
| `logistics.return.adjust` | editable | 1 |
| `logistics.sales_return.create` | editable | 1 |
| `logistics.sales_return.post` | editable | 1 |
| `logistics.sales_return.view` | default(editable) | 3 |
| `logistics.shipment_return.create` | editable | 1 |
| `logistics.shipment_return.post` | editable | 1 |
| `logistics.shipment_return.view` | default(editable) | 3 |
| `logistics.vehicle.create` | editable | 1 |
| `logistics.vehicle.edit` | editable | 4 |

## manufacturing (22)

| Node | Access level required | Routes |
|---|---|---|
| `manufacturing.bom.create` | editable | 1 |
| `manufacturing.bom.delete` | editable | 1 |
| `manufacturing.bom.edit` | editable | 2 |
| `manufacturing.bom.view` | read-only | 2 |
| `manufacturing.routing.create` | editable | 1 |
| `manufacturing.routing.delete` | editable | 1 |
| `manufacturing.routing.edit` | editable | 2 |
| `manufacturing.routing.view` | read-only | 2 |
| `manufacturing.work_center.create` | editable | 1 |
| `manufacturing.work_center.delete` | editable | 1 |
| `manufacturing.work_center.edit` | editable | 1 |
| `manufacturing.work_center.view` | read-only | 2 |
| `manufacturing.work_order.cancel` | editable | 1 |
| `manufacturing.work_order.complete` | editable | 1 |
| `manufacturing.work_order.create` | editable | 1 |
| `manufacturing.work_order.finished_goods_receive` | editable | 1 |
| `manufacturing.work_order.hold` | editable | 2 |
| `manufacturing.work_order.material_issue` | editable | 1 |
| `manufacturing.work_order.material_return` | editable | 1 |
| `manufacturing.work_order.operation_execute` | editable | 2 |
| `manufacturing.work_order.release` | editable | 1 |
| `manufacturing.work_order.view` | read-only | 2 |

## payroll (10)

| Node | Access level required | Routes |
|---|---|---|
| `payroll.adjustment.create` | editable | 1 |
| `payroll.compensation.create` | editable | 1 |
| `payroll.compensation.view` | read-only | 1 |
| `payroll.period.create` | editable | 1 |
| `payroll.period.view` | read-only | 1 |
| `payroll.run.approve` | editable | 2 |
| `payroll.run.calculate` | editable | 1 |
| `payroll.run.disburse` | editable | 1 |
| `payroll.run.review` | editable | 1 |
| `payroll.run.view` | read-only | 6 |

## procurement (24)

| Node | Access level required | Routes |
|---|---|---|
| `procurement.goods_receipt.create` | editable | 1 |
| `procurement.goods_receipt.view` | read-only | 1 |
| `procurement.purchase_order.approve` | editable | 2 |
| `procurement.purchase_order.create` | editable | 1 |
| `procurement.purchase_order.edit` | editable | 2 |
| `procurement.purchase_order.view` | read-only | 2 |
| `procurement.purchase_request.approve` | editable | 2 |
| `procurement.purchase_request.create` | editable | 2 |
| `procurement.purchase_request.edit` | editable | 2 |
| `procurement.purchase_request.view` | read-only | 4 |
| `procurement.rfq.award` | editable | 1 |
| `procurement.rfq.create` | editable | 1 |
| `procurement.rfq.edit` | editable | 2 |
| `procurement.rfq.record_quotation` | editable | 1 |
| `procurement.rfq.view` | read-only | 3 |
| `procurement.supplier.create` | editable | 1 |
| `procurement.supplier.edit` | editable | 5 |
| `procurement.supplier.view` | read-only | 4 |
| `procurement.supplier_invoice.create` | editable | 1 |
| `procurement.supplier_invoice.post` | editable | 1 |
| `procurement.supplier_invoice.view` | read-only | 6 |
| `procurement.supplier_invoice.void` | editable | 1 |
| `procurement.supplier_payment.create` | editable | 1 |
| `procurement.supplier_payment.view` | read-only | 2 |

## reporting (2)

| Node | Access level required | Routes |
|---|---|---|
| `reporting.finance.export` | read-only | 1 |
| `reporting.finance.view` | read-only | 1 |

## sales (10)

| Node | Access level required | Routes |
|---|---|---|
| `sales.catalog.create` | editable | 3 |
| `sales.catalog.edit` | editable | 6 |
| `sales.customer.assign` | editable | 1 |
| `sales.customer.edit` | editable | 3 |
| `sales.customer_financial.edit` | editable | 1 |
| `sales.customer_status.edit` | editable | 1 |
| `sales.deposit.approve` | editable | 1 |
| `sales.deposit.reject` | editable | 1 |
| `sales.price_list.edit` | editable | 7 |
| `sales.rep.assign` | editable | 1 |

## system (5)

| Node | Access level required | Routes |
|---|---|---|
| `system.release.backup` | editable | 3 |
| `system.release.deploy` | editable, read-only | 7 |
| `system.release.restore` | editable | 8 |
| `system.release.rollback` | editable | 1 |
| `system.release.view` | read-only | 12 |

## targets (3)

| Node | Access level required | Routes |
|---|---|---|
| `targets.target.approve` | editable | 1 |
| `targets.target.create` | editable | 2 |
| `targets.target.view` | read-only | 1 |

## Controllers that do NOT run CompanyContextGuard (12 of 70)

- `foundation/admin/admin.controller.ts`
- `foundation/configuration-engine/configuration.controller.ts`
- `foundation/entitlement/entitlement.controller.ts`
- `foundation/integrations/interface/integration-order-intake.controller.ts`
- `foundation/integrations/interface/integrations.controller.ts`
- `foundation/limit-engine/limit.controller.ts`
- `foundation/media/media.controller.ts`
- `foundation/navigation/navigation.controller.ts`
- `foundation/organization/organization.controller.ts`
- `foundation/release/release.controller.ts`
- `foundation/terminology/terminology.controller.ts`
- `health/health.controller.ts`

## Controllers gated by a hard-coded role key (`@RequireRole`)

- *(correction 2026-10-07: `domains/treasury/interface/treasury.controller.ts` appeared here because the text `@RequireRole('admin','finance')` occurs in a comment describing its former gate; it is NOT role-gated — every route requires `@RequirePermission('finance','editable')`.)*
- `foundation/admin/admin.controller.ts :: 'admin' | 'admin', 'sales_manager'`
- `foundation/audit/installation-audit.controller.ts :: 'admin'`
- `foundation/company/company-registry.controller.ts :: 'admin' | 'admin'`
- `foundation/company/installation-membership.controller.ts :: 'admin'`
- `foundation/integrations/interface/integrations.controller.ts :: 'admin' | 'admin' | 'admin'`
- `foundation/organization/organization.controller.ts :: 'admin' | 'admin' | 'admin'`
- `foundation/plans/plans.controller.ts :: 'admin'`
- `foundation/release/release.controller.ts :: 'admin' | 'admin' | 'admin'`
