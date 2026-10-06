import { DataSource } from 'typeorm';
import { TwoCompanyHarness } from './two-company-real-pg-harness';
import { CORE_COMPANY_ENTITIES } from '../company/core-company-entities';

/**
 * Area 21 test helper (2026-10-05). The two-company harness's control-plane connection only registers the
 * handful of entities the harness itself needs. A domain isolation spec also needs an AMBIENT/Platform
 * `DataSource` carrying the foundation entities the engines touch on the ambient path (numbering, approval,
 * process, audit, outbox, limits, organization …) — `CORE_COMPANY_ENTITIES` is exactly that set, and the
 * harness migrates the control-plane database with the `core` tag, so the tables exist.
 *
 * The returned DataSource points at the SAME disposable control-plane database the harness created (so it is
 * dropped with it) and must be destroyed by the spec in `afterAll` BEFORE `h.teardown()`.
 */
export async function createAmbientDataSource(h: TwoCompanyHarness, extraEntities: Function[] = []): Promise<DataSource> {
  const o = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
  const ds = new DataSource({
    type: 'postgres',
    host: o.host,
    port: o.port,
    username: o.username,
    password: o.password,
    database: o.database,
    entities: [...CORE_COMPANY_ENTITIES, ...extraEntities],
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  return ds;
}
