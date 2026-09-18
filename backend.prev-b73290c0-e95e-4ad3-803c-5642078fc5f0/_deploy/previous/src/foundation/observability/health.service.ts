import { Injectable } from '@nestjs/common';
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
  constructor(private readonly dataSource: DataSource) {}

  private async checkDatabase(): Promise<ComponentHealth> {
    try {
      await this.dataSource.query('SELECT 1');
      return { name: 'database', healthy: true };
    } catch (err) {
      return { name: 'database', healthy: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async checkAll(): Promise<OverallHealth> {
    const components = [await this.checkDatabase()];
    const status = components.every((c) => c.healthy) ? 'ok' : 'degraded';
    return { status, components };
  }
}
