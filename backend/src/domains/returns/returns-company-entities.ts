import { ReturnCredit } from './infrastructure/return-credit.entity';
import { ReturnDisposition } from './infrastructure/return-disposition.entity';
import { ReturnRequest } from './infrastructure/return-request.entity';
import { SalesReturn } from './infrastructure/sales-return.entity';
import { SalesReturnLine } from './infrastructure/sales-return-line.entity';
import { ShipmentReturn } from './infrastructure/shipment-return.entity';
import { ShipmentReturnLine } from './infrastructure/shipment-return-line.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Returns' own
 * Company-connection-capable entities (`ReturnsService`). `SalesReturn`/
 * `SalesReturnLine` added 2026-09-28 (Area 21, `sales-returns.controller.ts`'s turn);
 * `ShipmentReturn`/`ShipmentReturnLine` added the same day (`shipment-returns.controller.ts`).
 */
export const RETURNS_COMPANY_ENTITIES = [ReturnCredit, ReturnDisposition, ReturnRequest, SalesReturn, SalesReturnLine, ShipmentReturn, ShipmentReturnLine];
