import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IntegrationConnector } from '../infrastructure/integration-connector.entity';
import { IntegrationCredential } from '../infrastructure/integration-credential.entity';
import { IntegrationProductMapping } from '../infrastructure/integration-product-mapping.entity';
import { IntegrationSyncLog } from '../infrastructure/integration-sync-log.entity';
import { canTransitionConnectorStatus, ConnectorStatus } from '../domain/connector-status';
import { isValidConnectorType } from '../domain/connector-types';
import { CustomerFacingOrderStatus } from '../domain/order-status-contract';
import { CredentialCipherService } from './credential-cipher.service';
import { StoreConnectorAdapter } from './store-connector-adapter';
import { QrStoreConnector } from './connectors/qr-store.connector';
import { AuditService } from '../../audit/audit.service';
import { EventBusService } from '../../events/event-bus.service';
// Security Assurance Gate — Track S20 (Cleanup), found 2026-09-08:
// `no-restricted-imports` (eslint.config.mjs) flags these 4 lines as
// cross-domain internal imports (DAII_DOMAIN_BOUNDARIES.md). Investigated
// before suppressing: this is a REAL, pre-existing pattern already used
// throughout the domain layer — `sales-orders.service.ts` imports
// Commerce's `ProductsService`/`PriceListsService` and CRM's
// `CustomersService` the exact same way — but it escapes this rule there
// because the relative path from `domains/sales-orders/application/` to
// a sibling domain (`../../commerce/application/...`) never spells out
// the literal substring `domains/commerce/application` the rule matches
// on. From `foundation/integrations/application/`, the same relationship
// needs one more `../`, which DOES spell out that literal substring —
// exactly the "same-level relative import... NOT caught by this rule"
// gap the rule's own doc comment already discloses, just triggering the
// opposite way (a false positive here, not a false negative). No
// "published interface/contract" module exists ANYWhere in this codebase
// for any of these 4 domains today (`grep`-confirmed: no `contract`/
// `facade`/`published`-named file anywhere under `src/domains`) — so
// building one FOR THIS FILE ALONE would fix this one import path while
// leaving the identical, more common pattern (Sales Orders -> Commerce/
// CRM) silently uncovered, which is inconsistent and provides false
// confidence rather than a real fix. The genuine fix — TypeScript path
// aliases or a resolved-path-aware rule (e.g. eslint-plugin-boundaries)
// — is already named as backlog in the rule's own doc comment and is a
// deliberate, separate, cross-cutting task, not a one-file patch.
// eslint-disable-next-line no-restricted-imports
import { ProductsService } from '../../../domains/commerce/application/products.service';
// eslint-disable-next-line no-restricted-imports
import { CustomersService } from '../../../domains/crm/application/customers.service';
// eslint-disable-next-line no-restricted-imports
import { SalesOrdersService } from '../../../domains/sales-orders/application/sales-orders.service';
// eslint-disable-next-line no-restricted-imports
import { InventoryService } from '../../../domains/inventory-warehouse/application/inventory.service';

export interface ReconciliationEntry {
  externalProductId: string;
  sku: string;
  name: string;
}
export interface ReconciliationReport {
  matched: Array<{ daiiProductId: string; sku: string; externalProductId: string }>;
  newInExternal: ReconciliationEntry[]; // exists in QR, no Daii product with that SKU
  newInDaii: Array<{ daiiProductId: string; sku: string; name: string }>; // exists in Daii, not in the QR list supplied
}

/** Internal Process Engine states -> the clean customer-facing contract (CTO directive §17). */
function mapInternalStateToCustomerFacingStatus(state: string): CustomerFacingOrderStatus {
  switch (state) {
    case 'draft':
    case 'submitted':
      return 'received';
    case 'supervisor_review':
    case 'manager_approval':
    case 'pending_resubmission':
    case 'deposit_verification':
      return 'processing';
    case 'released':
      return 'accepted';
    default:
      return 'processing';
  }
}

/**
 * External Integrations (Control Center) — CTO handover directive "Daii
 * <-> QR Store Integration & Pairing Architecture". The reusable
 * connector foundation (§9): QR Store is the first, not the only,
 * connector — every method below is generic over `connectorType`,
 * dispatching to a registered `StoreConnectorAdapter`, never branching
 * on "if QR then...".
 *
 * Deliberately NOT built here (disclosed scope boundary, directive
 * §13/§19/§20): a general synchronization engine, automatic real-time
 * availability push (recordMovement/reserveStock fire far too often for
 * a naive per-call push to be proportional — availability publish is a
 * manual/on-demand bulk action for V1), and Sales Order cancellation
 * (Daii's Process Engine has no `cancelled` state/action at all yet —
 * that is a Sales Orders domain gap, not something this connector
 * should silently smuggle in).
 */
@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly adapters: Record<string, StoreConnectorAdapter>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly cipher: CredentialCipherService,
    private readonly events: EventBusService,
    private readonly products: ProductsService,
    private readonly customers: CustomersService,
    private readonly salesOrders: SalesOrdersService,
    private readonly inventory: InventoryService,
    qrStoreConnector: QrStoreConnector,
  ) {
    // The one place a new connector type gets registered (directive §9).
    this.adapters = { qr_store: qrStoreConnector };
  }

  /**
   * "A change in Daii should be capable of updating the corresponding QR
   * Store data automatically" (directive §3/§6) — subscribes to the
   * outbox topics `ProductsService` now publishes and pushes to every
   * CONNECTED connector. A failing/unreachable connector never blocks
   * another (`publishProduct` itself never throws) or the product write
   * that triggered this (dispatch runs after that write's own
   * transaction has already committed).
   */
  onModuleInit(): void {
    const publishToAllConnected = async (payload: Record<string, unknown>) => {
      const productId = payload.productId as string;
      const connectors = await this.dataSource
        .getRepository(IntegrationConnector)
        .find({ where: { status: 'connected' } });
      for (const connector of connectors) {
        await this.publishProduct(connector.id, productId, null);
      }
    };
    this.events.subscribe('commerce.product.created', publishToAllConnected);
    this.events.subscribe('commerce.product.status_changed', publishToAllConnected);
    this.events.subscribe('commerce.product.price_changed', publishToAllConnected);
    this.events.subscribe('commerce.product.name_changed', publishToAllConnected);
  }

  private adapterFor(connectorType: string): StoreConnectorAdapter {
    const adapter = this.adapters[connectorType];
    if (!adapter) throw new BadRequestException(`No connector adapter registered for type "${connectorType}".`);
    return adapter;
  }

  // ---------------------------------------------------------------------
  // Connector lifecycle (Control Center)
  // ---------------------------------------------------------------------

  async createConnector(
    connectorType: string,
    name: string,
    config: Record<string, unknown>,
    actorUserId: string | null,
  ): Promise<IntegrationConnector> {
    if (!isValidConnectorType(connectorType)) {
      throw new BadRequestException(`Unknown connector type "${connectorType}".`);
    }
    if (!config.systemUserId || typeof config.systemUserId !== 'string') {
      throw new BadRequestException(
        'config.systemUserId is required — the Daii user whose Scope orders created through this connector are assigned under.',
      );
    }

    const repo = this.dataSource.getRepository(IntegrationConnector);
    const saved = await repo.save(repo.create({ connectorType, name, config, status: 'pending' }));

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'integration.connector.created',
      resource: 'integration_connector',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { connectorType, name },
    });

    return saved;
  }

  async listConnectors(): Promise<IntegrationConnector[]> {
    return this.dataSource.getRepository(IntegrationConnector).find({ order: { createdAt: 'DESC' } });
  }

  async getConnector(connectorId: string): Promise<IntegrationConnector> {
    const connector = await this.dataSource.getRepository(IntegrationConnector).findOne({ where: { id: connectorId } });
    if (!connector) throw new NotFoundException(`Integration connector "${connectorId}" not found.`);
    return connector;
  }

  private async setConnectorStatus(connectorId: string, newStatus: ConnectorStatus): Promise<IntegrationConnector> {
    const repo = this.dataSource.getRepository(IntegrationConnector);
    const connector = await this.getConnector(connectorId);
    if (!canTransitionConnectorStatus(connector.status, newStatus)) {
      throw new ConflictException(`Cannot transition connector from "${connector.status}" to "${newStatus}".`);
    }
    connector.status = newStatus;
    if (newStatus === 'connected') connector.lastConnectedAt = new Date();
    return repo.save(connector);
  }

  /**
   * CTO directive §11/§12 step 2 — accepts a pairing code/token and
   * stores it encrypted, revoking any prior active credential for this
   * connector (never two live credentials at once). The plaintext token
   * is held only for this call's duration — never logged, never
   * returned by any read endpoint afterward.
   */
  async pairConnector(connectorId: string, pairingToken: string, actorUserId: string | null): Promise<IntegrationConnector> {
    if (!pairingToken || pairingToken.length < 8) {
      throw new BadRequestException('Pairing token is missing or too short.');
    }
    const connector = await this.getConnector(connectorId);

    await this.dataSource.transaction(async (manager) => {
      const credRepo = manager.getRepository(IntegrationCredential);
      await manager.query(
        `UPDATE integration_credentials SET revoked = true, "revokedAt" = now() WHERE "connectorId" = $1 AND revoked = false`,
        [connectorId],
      );
      await credRepo.save(credRepo.create({ connectorId, encryptedValue: this.cipher.encrypt(pairingToken), revoked: false }));
    });

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'integration.connector.paired',
      resource: 'integration_connector',
      resourceId: connectorId,
      result: 'success',
      correlationId: null,
    });

    return connector;
  }

  /** Alias used by rotation — same operation, different audit label for a clearer log trail. */
  async rotateCredential(connectorId: string, newPairingToken: string, actorUserId: string | null): Promise<void> {
    await this.pairConnector(connectorId, newPairingToken, actorUserId);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'integration.connector.credential_rotated',
      resource: 'integration_connector',
      resourceId: connectorId,
      result: 'success',
      correlationId: null,
    });
  }

  private async getActiveCredential(connectorId: string): Promise<string> {
    const cred = await this.dataSource
      .getRepository(IntegrationCredential)
      .findOne({ where: { connectorId, revoked: false }, order: { createdAt: 'DESC' } });
    if (!cred) throw new ConflictException(`Connector "${connectorId}" has no active pairing credential — pair it first.`);
    return this.cipher.decrypt(cred.encryptedValue);
  }

  /** CTO directive §12 step 3/4 — validates the pairing and surfaces the recognized store identity. */
  async testConnection(connectorId: string, actorUserId: string | null): Promise<{ ok: boolean; identity?: { externalStoreId: string; storeName: string }; error?: string }> {
    const connector = await this.getConnector(connectorId);
    const credential = await this.getActiveCredential(connectorId);
    const adapter = this.adapterFor(connector.connectorType);

    const result = await adapter.testConnection(connector.config, credential);

    await this.logSync(connectorId, 'outbound', 'connector.test', null, result.ok ? 'success' : 'failed', result.error ?? null);

    if (result.ok) {
      await this.setConnectorStatus(connectorId, 'connected');
    } else {
      const repo = this.dataSource.getRepository(IntegrationConnector);
      if (connector.status !== 'disconnected') {
        connector.status = 'error';
        await repo.save(connector);
      }
    }

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'integration.connector.tested',
      resource: 'integration_connector',
      resourceId: connectorId,
      result: result.ok ? 'success' : 'failure',
      correlationId: null,
      after: { ok: result.ok, identity: result.identity, error: result.error },
    });

    return result;
  }

  async disconnectConnector(connectorId: string, actorUserId: string | null): Promise<IntegrationConnector> {
    const connector = await this.setConnectorStatus(connectorId, 'disconnected');
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'integration.connector.disconnected',
      resource: 'integration_connector',
      resourceId: connectorId,
      result: 'success',
      correlationId: null,
    });
    return connector;
  }

  // ---------------------------------------------------------------------
  // Product mapping / initial reconciliation (directive §8/§14)
  // ---------------------------------------------------------------------

  async listMappings(connectorId: string): Promise<IntegrationProductMapping[]> {
    return this.dataSource.getRepository(IntegrationProductMapping).find({ where: { connectorId } });
  }

  async createMapping(connectorId: string, daiiProductId: string, externalProductId: string, actorUserId: string | null): Promise<IntegrationProductMapping> {
    const product = await this.products.getProductSnapshot(daiiProductId);
    if (!product) throw new NotFoundException(`Product "${daiiProductId}" not found.`);

    const repo = this.dataSource.getRepository(IntegrationProductMapping);
    const existing = await repo.findOne({ where: { connectorId, daiiProductId } });
    const saved = existing
      ? await repo.save({ ...existing, externalProductId, lastSyncedAt: new Date() })
      : await repo.save(repo.create({ connectorId, daiiProductId, externalProductId, lastSyncedAt: new Date() }));

    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'integration.mapping.created',
      resource: 'integration_product_mapping',
      resourceId: saved.id,
      result: 'success',
      correlationId: null,
      after: { connectorId, daiiProductId, externalProductId },
    });

    return saved;
  }

  /**
   * Read-only proposal — CTO directive §14: "do NOT blindly import or
   * overwrite everything... matching/mapping... review where necessary...
   * confirm." Matches by SKU only, NEVER by product name (directive §8).
   * Writes nothing; call `createMapping` per confirmed pair afterward.
   */
  async proposeReconciliation(connectorId: string, externalProducts: ReconciliationEntry[]): Promise<ReconciliationReport> {
    await this.getConnector(connectorId); // 404s early for an unknown connector
    const existingMappings = await this.listMappings(connectorId);
    const alreadyMappedDaiiIds = new Set(existingMappings.map((m) => m.daiiProductId));

    const daiiProducts = await this.products.listAllProducts();
    const daiiBySku = new Map(daiiProducts.map((p) => [p.sku, p]));
    const externalSkus = new Set(externalProducts.map((e) => e.sku));

    const matched: ReconciliationReport['matched'] = [];
    const newInExternal: ReconciliationEntry[] = [];
    for (const ext of externalProducts) {
      const daiiProduct = daiiBySku.get(ext.sku);
      if (daiiProduct) matched.push({ daiiProductId: daiiProduct.id, sku: ext.sku, externalProductId: ext.externalProductId });
      else newInExternal.push(ext);
    }

    const newInDaii = daiiProducts
      .filter((p) => !externalSkus.has(p.sku) && !alreadyMappedDaiiIds.has(p.id))
      .map((p) => ({ daiiProductId: p.id, sku: p.sku, name: p.name }));

    return { matched, newInExternal, newInDaii };
  }

  /** Writes the confirmed subset of a `proposeReconciliation` report as real mappings — the explicit "Confirm" step of directive §14. */
  async confirmReconciliation(
    connectorId: string,
    confirmed: Array<{ daiiProductId: string; externalProductId: string }>,
    actorUserId: string | null,
  ): Promise<IntegrationProductMapping[]> {
    const results: IntegrationProductMapping[] = [];
    for (const pair of confirmed) {
      results.push(await this.createMapping(connectorId, pair.daiiProductId, pair.externalProductId, actorUserId));
    }
    return results;
  }

  // ---------------------------------------------------------------------
  // Outbound publishing (Daii -> QR): directive §3/§6
  // ---------------------------------------------------------------------

  /** Never throws — a QR outage must not break the Daii write that triggered this (event hook or manual). Failure is logged and swallowed. */
  async publishProduct(connectorId: string, daiiProductId: string, _actorUserId: string | null): Promise<void> {
    let connector: IntegrationConnector;
    try {
      connector = await this.getConnector(connectorId);
    } catch {
      return; // connector was deleted/never existed — nothing to publish to
    }
    if (connector.status !== 'connected') return;

    const product = await this.products.getProductSnapshot(daiiProductId);
    if (!product) return;

    try {
      const credential = await this.getActiveCredential(connectorId);
      const adapter = this.adapterFor(connector.connectorType);
      const mapping = await this.dataSource.getRepository(IntegrationProductMapping).findOne({ where: { connectorId, daiiProductId } });

      const result = await adapter.publishProduct(connector.config, credential, {
        daiiProductId,
        externalProductId: mapping?.externalProductId ?? null,
        sku: product.sku,
        name: product.name,
        status: product.status,
        price: product.unitPrice,
      });

      const mappingRepo = this.dataSource.getRepository(IntegrationProductMapping);
      if (mapping) {
        await mappingRepo.save({ ...mapping, externalProductId: result.externalProductId, lastSyncedAt: new Date() });
      } else {
        await mappingRepo.save(mappingRepo.create({ connectorId, daiiProductId, externalProductId: result.externalProductId, lastSyncedAt: new Date() }));
      }

      await this.logSync(connectorId, 'outbound', 'product.published', daiiProductId, 'success', null);
    } catch (err) {
      await this.logSync(connectorId, 'outbound', 'product.published', daiiProductId, 'failed', (err as Error).message);
    }
  }

  /** CTO directive §12 step 6 — "Run initial synchronization" / the manual "Publish Now" bulk trigger. */
  async publishAllProducts(connectorId: string, actorUserId: string | null): Promise<{ attempted: number }> {
    const all = await this.products.listAllProducts();
    for (const p of all) await this.publishProduct(connectorId, p.id, actorUserId);
    return { attempted: all.length };
  }

  /**
   * Manual/on-demand for V1 (see class doc's disclosed scope boundary —
   * no automatic real-time push). Requires an existing product mapping
   * (publish the product first).
   */
  async publishAvailability(connectorId: string, daiiProductId: string, _actorUserId: string | null): Promise<void> {
    const connector = await this.getConnector(connectorId);
    if (connector.status !== 'connected') throw new ConflictException(`Connector "${connectorId}" is not connected.`);

    const mapping = await this.dataSource.getRepository(IntegrationProductMapping).findOne({ where: { connectorId, daiiProductId } });
    if (!mapping) throw new NotFoundException(`Product "${daiiProductId}" has no mapping for connector "${connectorId}" — publish it first.`);

    const product = await this.products.getProductSnapshot(daiiProductId);
    if (!product) throw new NotFoundException(`Product "${daiiProductId}" not found.`);
    const available = await this.inventory.getTotalAvailable(daiiProductId);

    try {
      const credential = await this.getActiveCredential(connectorId);
      const adapter = this.adapterFor(connector.connectorType);
      await adapter.publishAvailability(connector.config, credential, { externalProductId: mapping.externalProductId, sku: product.sku, available });
      await this.logSync(connectorId, 'outbound', 'availability.published', daiiProductId, 'success', String(available));
    } catch (err) {
      await this.logSync(connectorId, 'outbound', 'availability.published', daiiProductId, 'failed', (err as Error).message);
      throw err;
    }
  }

  /** Bulk variant over every currently-mapped product — the "Publish Now" availability action. */
  async publishAllAvailability(connectorId: string, actorUserId: string | null): Promise<{ attempted: number }> {
    const mappings = await this.listMappings(connectorId);
    for (const m of mappings) {
      try {
        await this.publishAvailability(connectorId, m.daiiProductId, actorUserId);
      } catch {
        // already logged by publishAvailability; continue with the rest of the batch
      }
    }
    return { attempted: mappings.length };
  }

  /**
   * CTO directive §17 — manual/on-demand for V1 (see class doc). Caller
   * supplies `externalOrderId` (correlatable from `receiveOrder`'s
   * response or the sync log) and, optionally, an explicit
   * customer-facing status override; otherwise it's derived from the
   * order's current internal state.
   */
  async publishOrderStatus(
    connectorId: string,
    salesOrderId: string,
    externalOrderId: string,
    actorUserId: string | null,
    overrideStatus?: CustomerFacingOrderStatus,
  ): Promise<void> {
    const connector = await this.getConnector(connectorId);
    if (connector.status !== 'connected') throw new ConflictException(`Connector "${connectorId}" is not connected.`);

    const status = overrideStatus ?? mapInternalStateToCustomerFacingStatus(await this.salesOrders.getOrderStatus(salesOrderId));

    try {
      const credential = await this.getActiveCredential(connectorId);
      const adapter = this.adapterFor(connector.connectorType);
      await adapter.publishOrderStatus(connector.config, credential, { externalOrderId, status });
      await this.logSync(connectorId, 'outbound', 'order.status_published', externalOrderId, 'success', status);
    } catch (err) {
      await this.logSync(connectorId, 'outbound', 'order.status_published', externalOrderId, 'failed', (err as Error).message);
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Inbound order intake (QR -> Daii): directive §4/§5/§15/§16
  // ---------------------------------------------------------------------

  /**
   * The one path a QR customer order enters Daii through — reuses the
   * EXISTING Sales Order domain end to end (directive §5: "Do NOT create
   * a second independent operational order system in QR" / §20: "Do NOT
   * rebuild: Daii Sales Order domain"). Idempotent on
   * (connectorId, 'order.received', externalOrderId): a retried/duplicate
   * delivery of the same QR order returns the SAME Daii Sales Order,
   * never creates a second one (directive §16).
   */
  async receiveOrder(
    connectorId: string,
    externalOrderId: string,
    customer: { name: string; phone: string },
    lines: Array<{ externalProductId: string; quantity: number; discountAmount?: string }>,
    actorUserId: string | null,
  ): Promise<{ daiiSalesOrderId: string; orderNumber: string; status: CustomerFacingOrderStatus; duplicate: boolean }> {
    const existing = await this.dataSource.getRepository(IntegrationSyncLog).findOne({
      where: { connectorId, eventType: 'order.received', externalReference: externalOrderId, status: 'success' },
      order: { createdAt: 'DESC' },
    });
    if (existing?.detail) {
      const parsed = JSON.parse(existing.detail) as { daiiSalesOrderId: string; orderNumber: string };
      const status = mapInternalStateToCustomerFacingStatus(await this.salesOrders.getOrderStatus(parsed.daiiSalesOrderId));
      return { ...parsed, status, duplicate: true };
    }

    const connector = await this.getConnector(connectorId);
    if (connector.status !== 'connected') {
      throw new ConflictException(`Connector "${connectorId}" is not connected — cannot accept orders.`);
    }
    const systemUserId = connector.config.systemUserId as string;

    if (lines.length === 0) throw new BadRequestException('Order must have at least one line.');

    try {
      // Resolve every line's Daii product BEFORE writing anything — an
      // order with any unmapped product is rejected whole, never
      // partially created (same all-or-nothing discipline as
      // SalesOrdersService.createOrder's own line validation).
      const mappingRepo = this.dataSource.getRepository(IntegrationProductMapping);
      const resolvedLines: Array<{ productId: string; quantity: number; discountAmount?: string }> = [];
      for (const line of lines) {
        const mapping = await mappingRepo.findOne({ where: { connectorId, externalProductId: line.externalProductId } });
        if (!mapping) {
          throw new BadRequestException(`No product mapping found for external product "${line.externalProductId}".`);
        }
        resolvedLines.push({ productId: mapping.daiiProductId, quantity: line.quantity, discountAmount: line.discountAmount });
      }

      let daiiCustomer = await this.customers.findByPhone(customer.phone);
      if (!daiiCustomer) {
        daiiCustomer = await this.customers.createCustomer({ name: customer.name, phone: customer.phone }, actorUserId);
        await this.customers.assignSalesRep(daiiCustomer.id, systemUserId, 'primary', actorUserId);
      }

      // QR order intake has no human present to pick a warehouse (Sales
      // Order creation now reserves stock at creation time — CTO
      // directive, "PRIORITY 2 — STOCK AVAILABILITY" — so a warehouse is
      // required). Falls back to the first active warehouse; a genuine
      // multi-warehouse QR routing decision is out of scope here (QR
      // Store integration directive explicitly said not to rebuild
      // Inventory/Fulfillment) — if none is active, this fails loudly
      // (BadRequestException from createOrder) rather than silently
      // picking an inactive one.
      const warehouses = await this.inventory.listWarehouses();
      const defaultWarehouse = warehouses.find((w) => w.status === 'active');
      if (!defaultWarehouse) {
        throw new BadRequestException('No active warehouse is configured — cannot reserve stock for a QR order.');
      }

      // A QR Store order has no shipping-method concept of its own (CTO
      // directive §2's field is Daii-internal) — defaults to
      // 'shipping_company', the closer fit for an external/online buyer
      // vs. an in-person company-vehicle delivery. Disclosed default, not
      // a QR-side setting; revisit if QR orders ever need to choose.
      const order = await this.salesOrders.createOrder(
        daiiCustomer.id,
        systemUserId,
        resolvedLines,
        actorUserId,
        defaultWarehouse.id,
        'shipping_company',
      );

      await this.logSync(
        connectorId,
        'inbound',
        'order.received',
        externalOrderId,
        'success',
        JSON.stringify({ daiiSalesOrderId: order.id, orderNumber: order.orderNumber }),
      );

      return { daiiSalesOrderId: order.id, orderNumber: order.orderNumber, status: 'received', duplicate: false };
    } catch (err) {
      await this.logSync(connectorId, 'inbound', 'order.received', externalOrderId, 'failed', (err as Error).message);
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Sync log visibility (directive §20)
  // ---------------------------------------------------------------------

  async listSyncLogs(connectorId: string, limit = 100): Promise<IntegrationSyncLog[]> {
    return this.dataSource.getRepository(IntegrationSyncLog).find({ where: { connectorId }, order: { createdAt: 'DESC' }, take: limit });
  }

  private async logSync(
    connectorId: string,
    direction: 'outbound' | 'inbound',
    eventType: string,
    externalReference: string | null,
    status: 'success' | 'failed' | 'skipped_duplicate',
    detail: string | null,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(IntegrationSyncLog);
    await repo.save(repo.create({ connectorId, direction, eventType, externalReference, status, detail }));
  }
}
