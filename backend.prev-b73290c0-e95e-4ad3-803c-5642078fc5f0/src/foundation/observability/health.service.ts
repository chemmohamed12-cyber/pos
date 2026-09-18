import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ComponentHealth {
  name: string;
  healthy: boolean;
  detail?: string;
}

export interface OverallHealth {
  status: 'ok' | 'degraded';
  components: ComponentHealth[];
}

/**
 * Observability — Stage 2 build-order item 15.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §17.
 *
 * Adopts RMS kernel/health's discipline (Class C pattern,
 * Daii/_source-audits/rms-step30/ §3): real functional round-trip
 * checks, never a hardcoded "ok". Each registered check actually
 * exercises the component it claims to verify.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * AUDIT-SEC-01 remediation (Security Assurance Gate, Track S1/S12,
   * 2026-09-08): `/health/deep` carries no auth guard by design — a
   * load-balancer health check can't attach a JWT — so anything returned
   * here is public. The raw driver/Postgres error string used to be
   * returned verbatim (connection parameters, internal hostnames, and
   * query fragments could leak). The real error is now logged
   * server-side only; the public response gets a fixed, generic string —
   * the same "public surface gets nothing beyond healthy/unhealthy"
   * discipline `AllExceptionsFilter` already applies to every other route.
   */
  private async checkDatabase(): Promise<ComponentHealth> {
    try {
      await this.dataSource.query('SELECT 1');
      return { name: 'database', healthy: true };
    } catch (err) {
      this.logger.error('Health check: database round-trip failed.', err instanceof Error ? err.stack : String(err));
      return { name: 'database', healthy: false, detail: 'database check failed' };
    }
  }

  async checkAll(): Promise<OverallHealth> {
    const components = [await this.checkDatabase()];
    const status = components.every((c) => c.healthy) ? 'ok' : 'degraded';
    return { status, components };
  }
}
