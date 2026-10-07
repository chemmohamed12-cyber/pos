import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntityManager } from 'typeorm';
import { CompanyScopedRequest } from '../company/company-context.guard';
import { AccessScopeService } from './access-scope.service';
import { WAREHOUSE_KEYED_TABLES, WAREHOUSE_SCOPE_KEY, WarehouseScopeSource } from './warehouse-scope.decorator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ScopedRequest = CompanyScopedRequest & { query: Record<string, unknown>; params: Record<string, string>; body: Record<string, unknown> };

/**
 * Authorization Foundation F6 — enforces the caller's warehouse scope on the routes that declare `@WarehouseScoped(...)`. Runs after `CompanyContextGuard`
 * (it needs the Company's own manager). A route outside the caller's scope answers 404, exactly like a missing record (anti-enumeration, ADR-005).
 *
 * Fails closed on structure (no Company context -> 404) and open only on data: an id that is absent or not a UUID is left to the DTO / pipe to reject (400), an
 * unknown record is left to the handler to report (404), and a warehouse without an org-unit link is unscoped (visible to everyone).
 * An unrestricted caller (the Company administrator) is answered from the request's already-loaded authorization context: no extra statement.
 */
@Injectable()
export class WarehouseScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly scopes: AccessScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const sources = this.reflector.getAllAndOverride<WarehouseScopeSource[]>(WAREHOUSE_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    if (!sources || sources.length === 0) return true;
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    if (!req.user || !req.companyContext) throw new NotFoundException();
    const scope = await this.scopes.forRequest(req);
    if (scope.unrestricted) return true;
    const manager = req.companyContext.dataSource.manager;
    for (const src of sources) {
      for (const id of await this.warehouseIdsOf(src, req, manager)) await this.scopes.assertWarehouse(scope, id, manager);
    }
    return true;
  }

  /** The warehouse id(s) a source points at (a keyed record may carry several, e.g. a transfer's source and destination — every one must be in scope). */
  private async warehouseIdsOf(src: WarehouseScopeSource, req: ScopedRequest, manager: EntityManager): Promise<string[]> {
    const asId = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
    if ('recordOf' in src) {
      const id = asId(src.param ? req.params?.[src.param] : src.query ? req.query?.[src.query] : src.body ? req.body?.[src.body] : null);
      if (!id) return [];
      const { table, columns } = WAREHOUSE_KEYED_TABLES[src.recordOf];
      const rows: Array<Record<string, string | null>> = await manager.query(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}" WHERE "id" = $1`, [id]);
      return rows.length ? columns.map((c) => rows[0][c]).filter((v): v is string => !!v) : [];
    }
    const one = 'query' in src ? asId(req.query?.[src.query]) : 'body' in src ? asId(req.body?.[src.body]) : asId(req.params?.[src.param]);
    return one ? [one] : [];
  }
}
